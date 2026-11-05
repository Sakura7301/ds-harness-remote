import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { accountDeviceDescriptorSchema, type AccountDeviceDescriptor } from '@dsh-remote/protocol'
import { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const secret = (): string => randomBytes(32).toString('base64url')
export const equal = (left: string, right: string): boolean => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)))

/** Minimum password length, shared by registration and the bootstrap account. */
export const PASSWORD_MIN_LENGTH = 12
/** Self-service usernames: letters/digits first, then letters, digits, dot, dash or underscore. */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/
/** Per-account device and token caps; the global caps scale with the account count. */
const ACCOUNT_MAX_DEVICES = 256
const ACCOUNT_MAX_TOKENS = 16_384
const ACCOUNT_NAME_MAX_LENGTH = 64
const EMAIL_MAX_LENGTH = 254
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Salt used when an unknown account is probed, so a miss costs the same work as a hit. */
const UNKNOWN_ACCOUNT_SALT = 'unknown-account'

/**
 * Canonical account key. Names are stored and compared in one casing, so a
 * login with a different case cannot fork a second identity for one name.
 */
export const accountKey = (name: string): string => name.trim().toLowerCase()

export function validUsername(name: string): boolean {
  return USERNAME_PATTERN.test(name)
}
export function validEmail(email: string): boolean {
  return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email)
}

const accountRecordSchema = z.object({
  salt: z.string(),
  verifier: z.string(),
  createdAt: z.number(),
  /** Bootstrap accounts are administrators; self-service accounts default to users. */
  role: z.enum(['admin', 'user']).optional(),
  /** Bound address, lowercased. Login and password reset accept it once verified. */
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  disabled: z.boolean().optional(),
  /** Display name; the account key stays the email address. */
  nickname: z.string().optional(),
})
const smtpSchema = z.object({
  enabled: z.boolean().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  secure: z.boolean().optional(),
  user: z.string().optional(),
  pass: z.string().optional(),
  from: z.string().optional(),
})
const siteSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  announcement: z.string().optional(),
  footer: z.string().optional(),
})
const settingsSchema = z.object({ smtp: smtpSchema.optional(), site: siteSchema.optional() })
const tokenSchema = z.object({ kind: z.enum(['access', 'refresh']), deviceId: z.string(), account: z.string(), expires: z.number(), used: z.boolean() })
const savedDeviceSchema = z.object({ descriptor: accountDeviceDescriptorSchema, revoked: z.boolean(), lastSeenAt: z.number(), account: z.string() })
/** Browser sessions live in the state file, so a restart keeps users signed in. */
const sessionSchema = z.object({ account: z.string(), expires: z.number() })
/** Current on-disk format: many accounts, each owning its own devices and tokens. */
const stateSchema = z.object({
  version: z.literal(2),
  accounts: z.record(z.string(), accountRecordSchema),
  devices: z.record(z.string(), savedDeviceSchema),
  tokens: z.record(z.string(), tokenSchema),
  sessions: z.record(z.string(), sessionSchema).optional(),
  settings: settingsSchema.optional(),
})

/** Version 1 kept the single account in the state root; loaded only to migrate. */
const legacyTokenSchema = z.object({ kind: z.enum(['access', 'refresh']), deviceId: z.string(), expires: z.number(), used: z.boolean() })
const legacyDeviceSchema = z.object({ descriptor: accountDeviceDescriptorSchema, revoked: z.boolean(), lastSeenAt: z.number() })
const legacyStateSchema = z.object({
  version: z.literal(1),
  account: z.string(),
  salt: z.string(),
  verifier: z.string(),
  devices: z.record(z.string(), legacyDeviceSchema),
  tokens: z.record(z.string(), legacyTokenSchema),
})

type State = z.infer<typeof stateSchema>
type AccountRecord = z.infer<typeof accountRecordSchema>
type SavedDevice = z.infer<typeof savedDeviceSchema>
export type SmtpSettings = z.infer<typeof smtpSchema>
export type SiteSettings = z.infer<typeof siteSchema>
export interface AccountDescriptor {
  account: string
  nickname: string
  role: 'admin' | 'user'
  email?: string
  emailVerified: boolean
  disabled: boolean
  createdAt: number
  devices: number
}

/**
 * Single-process store. Only token digests and public identities reach disk.
 *
 * Accounts are independent: a device belongs to the account that registered it,
 * device tokens carry their owner, and nothing is listed across accounts. The
 * account/password passed from the environment is the bootstrap administrator
 * and is re-keyed on start, not the only identity the server accepts.
 */
export class Store {
  private readonly state: State
  onInvalidate: (id: string) => void = () => {}
  constructor(
    private readonly file: string,
    bootstrapAccount = '',
    bootstrapPassword = '',
    private readonly maxAccounts = 256,
    bootstrapNickname = '',
  ) {
    this.state = this.load()
    const normalize = this.normalizeIdentities(this.state)
    if (normalize) this.save()
    const bootstrap = accountKey(bootstrapAccount)
    if (bootstrap !== '' && bootstrapPassword !== '') this.ensureBootstrapAccount(bootstrap, bootstrapPassword, bootstrapNickname)
    this.save()
  }
  /**
   * Accounts are keyed by email. Older records were keyed by a chosen username;
   * move any that carry a bound address to that address so sign-in stays unified.
   */
  private normalizeIdentities(state: State): boolean {
    let changed = false
    for (const [key, record] of Object.entries(state.accounts)) {
      if (validEmail(key)) continue
      const email = (record.email ?? '').trim().toLowerCase()
      if (!validEmail(email) || Object.hasOwn(state.accounts, email)) continue
      state.accounts[email] = { ...record, email, emailVerified: true }
      delete state.accounts[key]
      for (const device of Object.values(state.devices)) if (device.account === key) device.account = email
      for (const token of Object.values(state.tokens)) if (token.account === key) token.account = email
      changed = true
    }
    return changed
  }
  private load(): State {
    if (!existsSync(this.file)) return { version: 2, accounts: {}, devices: {}, tokens: {} }
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
    const current = stateSchema.safeParse(raw)
    if (current.success) return current.data
    const legacy = legacyStateSchema.parse(raw)
    const account = accountKey(legacy.account)
    // Preserve every device and token under the single legacy identity.
    const devices: State['devices'] = {}
    for (const [id, device] of Object.entries(legacy.devices)) devices[id] = { ...device, account }
    const tokens: State['tokens'] = {}
    for (const [key, token] of Object.entries(legacy.tokens)) tokens[key] = { ...token, account }
    return {
      version: 2,
      accounts: { [account]: { salt: legacy.salt, verifier: legacy.verifier, createdAt: Date.now(), role: 'admin' } },
      devices,
      tokens,
    }
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  private createSalt(): string { return secret() }
  private verifyPassword(password: string, salt: string): string { return scryptSync(password, salt, 32).toString('hex') }
  /** The environment identity stays authoritative: a changed env password re-keys it. */
  private ensureBootstrapAccount(account: string, password: string, nickname: string): void {
    const existing = this.state.accounts[account]
    if (existing !== undefined && nickname.trim() !== '') existing.nickname = nickname.slice(0, ACCOUNT_NAME_MAX_LENGTH)
    if (existing === undefined) {
      // The bootstrap account keeps its historical, looser contract: any non-empty
      // name is accepted so an existing deployment never fails to start.
      if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`DSH_SERVER_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters.`)
      const salt = this.createSalt()
      this.state.accounts[account] = { salt, verifier: this.verifyPassword(password, salt), createdAt: Date.now(), role: 'admin', ...(nickname.trim() === '' ? {} : { nickname: nickname.slice(0, ACCOUNT_NAME_MAX_LENGTH) }) }
      return
    }
    // The environment account is the administrator, even for a pre-existing record.
    existing.role = 'admin'
    const verifier = this.verifyPassword(password, existing.salt)
    if (equal(verifier, existing.verifier)) return
    existing.verifier = verifier
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.account === account) delete this.state.tokens[key]
  }
  accountCount(): number { return Object.keys(this.state.accounts).length }
  accountExists(name: string): boolean { return Object.hasOwn(this.state.accounts, accountKey(name)) }
  /** Resolve a login identifier: the account name first, then a verified email. */
  resolveIdentifier(identifier: string): string | null {
    const key = accountKey(identifier)
    if (Object.hasOwn(this.state.accounts, key)) return key
    if (!validEmail(key)) return null
    for (const [account, record] of Object.entries(this.state.accounts)) {
      if (record.email === key && record.emailVerified === true) return account
    }
    return null
  }
  /** Account owning a verified email address, or null. Used by password recovery. */
  accountByEmail(email: string): string | null {
    const normalized = email.trim().toLowerCase()
    if (!validEmail(normalized)) return null
    for (const [account, record] of Object.entries(this.state.accounts)) {
      if (record.email === normalized && record.emailVerified === true) return account
    }
    return null
  }
  /**
   * Register a new account. Callers decide policy (open registration, invite
   * code); the store enforces the identity and password contract.
   */
  /**
   * Register a new account. The address is the identity; the nickname is only a
   * display name. Callers decide policy (open registration, invite code).
   */
  createAccount(email: string, password: string, options: { nickname?: string; verifiedEmail?: boolean } = {}): string {
    const account = accountKey(email)
    if (!validEmail(account)) throw new ApiError('INVALID_EMAIL')
    if (password.length < PASSWORD_MIN_LENGTH) throw new ApiError('WEAK_PASSWORD')
    if (Object.hasOwn(this.state.accounts, account)) throw new ApiError('ACCOUNT_EXISTS', 409)
    if (this.accountCount() >= this.maxAccounts) throw new ApiError('ACCOUNT_LIMIT_REACHED', 429)
    const salt = this.createSalt()
    const nickname = (options.nickname ?? '').trim().slice(0, ACCOUNT_NAME_MAX_LENGTH)
    this.state.accounts[account] = {
      salt,
      verifier: this.verifyPassword(password, salt),
      createdAt: Date.now(),
      role: 'user',
      email: account,
      emailVerified: options.verifiedEmail === true,
      ...(nickname === '' ? {} : { nickname }),
    }
    this.save()
    return account
  }
  setNickname(account: string, nickname: string): void {
    const record = this.assertExists(account)
    const trimmed = nickname.trim().slice(0, ACCOUNT_NAME_MAX_LENGTH)
    if (trimmed === '') throw new ApiError('INVALID_NICKNAME')
    record.nickname = trimmed
    this.save()
  }
  /**
   * Replace the account's address. Because the address is the sign-in key, the
   * record and everything it owns move to the new key.
   */
  changeEmail(account: string, email: string): string {
    const next = email.trim().toLowerCase()
    if (!validEmail(next)) throw new ApiError('INVALID_EMAIL')
    if (next !== account && Object.hasOwn(this.state.accounts, next)) throw new ApiError('EMAIL_IN_USE', 409)
    const record = this.assertExists(account)
    if (next === account) {
      record.email = next
      record.emailVerified = true
      this.save()
      return next
    }
    this.state.accounts[next] = { ...record, email: next, emailVerified: true }
    delete this.state.accounts[account]
    for (const device of Object.values(this.state.devices)) if (device.account === account) device.account = next
    for (const token of Object.values(this.state.tokens)) if (token.account === account) token.account = next
    this.save()
    return next
  }
  /** Constant-ish time: an unknown account still pays one scrypt derivation. */
  verify(identifier: string, password: string): string | null {
    const account = this.resolveIdentifier(identifier)
    const record = account === null ? undefined : this.state.accounts[account]
    const verifier = this.verifyPassword(password, record?.salt ?? UNKNOWN_ACCOUNT_SALT)
    if (account === null || record === undefined) return null
    if (!equal(verifier, record.verifier)) return null
    if (record.disabled === true) throw new ApiError('ACCOUNT_DISABLED', 403)
    return account
  }
  private assertExists(account: string): AccountRecord {
    const record = this.state.accounts[account]
    if (record === undefined) throw new ApiError('ACCOUNT_NOT_FOUND', 404)
    return record
  }
  roleOf(account: string): 'admin' | 'user' {
    return this.state.accounts[account]?.role === 'admin' ? 'admin' : 'user'
  }
  isAdmin(account: string): boolean { return this.roleOf(account) === 'admin' }
  descriptorOf(account: string): AccountDescriptor {
    const record = this.assertExists(account)
    return {
      account,
      nickname: record.nickname ?? account.split('@')[0] ?? account,
      role: record.role === 'admin' ? 'admin' : 'user',
      ...(record.email === undefined ? {} : { email: record.email }),
      emailVerified: record.emailVerified === true,
      disabled: record.disabled === true,
      createdAt: record.createdAt,
      devices: this.list(account).length,
    }
  }
  listAccounts(): AccountDescriptor[] {
    return Object.keys(this.state.accounts)
      .map(account => this.descriptorOf(account))
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  /** Remember a signed-in browser for a month; the cookie is HttpOnly anyway. */
  createSession(account: string, ttl = 30 * 86400_000): { value: string; expiresAt: number } {
    const now = Date.now()
    this.state.sessions = this.state.sessions ?? {}
    for (const [key, session] of Object.entries(this.state.sessions)) if (session.expires <= now) delete this.state.sessions[key]
    if (Object.keys(this.state.sessions).length >= 4096) throw new ApiError('RATE_LIMITED', 429)
    const value = secret()
    const expiresAt = now + ttl
    this.state.sessions[hash(value)] = { account, expires: expiresAt }
    this.save()
    return { value, expiresAt }
  }
  findSession(key: string): { account: string; expires: number } | null {
    const session = this.state.sessions?.[key]
    if (session === undefined) return null
    if (session.expires <= Date.now()) { this.deleteSession(key); return null }
    return session
  }
  deleteSession(key: string): void {
    if (this.state.sessions === undefined || !Object.hasOwn(this.state.sessions, key)) return
    delete this.state.sessions[key]
    this.save()
  }
  /** Email rebinding moves the account key; live cookies follow it. */
  moveSessions(from: string, to: string): void {
    let changed = false
    for (const session of Object.values(this.state.sessions ?? {})) if (session.account === from) { session.account = to; changed = true }
    if (changed) this.save()
  }
  setPassword(account: string, password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) throw new ApiError('WEAK_PASSWORD')
    const record = this.assertExists(account)
    const salt = this.createSalt()
    record.salt = salt
    record.verifier = this.verifyPassword(password, salt)
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.account === account) delete this.state.tokens[key]
    this.save()
  }
  /** Bind an email that the caller has already proven ownership of. */
  bindEmail(account: string, email: string): string {
    return this.changeEmail(account, email)
  }
  /**
   * Attach an address without moving the record. Used for the environment
   * bootstrap account, whose key may be a plain name rather than an address.
   */
  bindEmailAddress(account: string, email: string): void {
    const normalized = email.trim().toLowerCase()
    if (!validEmail(normalized)) throw new ApiError('INVALID_EMAIL')
    const existing = this.accountByEmail(normalized)
    if (existing !== null && existing !== account) throw new ApiError('EMAIL_IN_USE', 409)
    const record = this.assertExists(account)
    record.email = normalized
    record.emailVerified = true
    this.save()
  }
  setDisabled(account: string, disabled: boolean): void {
    const record = this.assertExists(account)
    record.disabled = disabled
    if (disabled) for (const [key, value] of Object.entries(this.state.tokens)) if (value.account === account) delete this.state.tokens[key]
    this.save()
  }
  deleteAccount(account: string): void {
    this.assertExists(account)
    delete this.state.accounts[account]
    for (const [id, device] of Object.entries(this.state.devices)) if (device.account === account) delete this.state.devices[id]
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.account === account) delete this.state.tokens[key]
    this.save()
  }
  smtp(): SmtpSettings { return { ...this.state.settings?.smtp } }
  setSmtp(patch: SmtpSettings): SmtpSettings {
    const next = { ...this.state.settings?.smtp, ...patch }
    this.state.settings = { ...this.state.settings, smtp: next }
    this.save()
    return { ...next }
  }
  site(): SiteSettings { return { ...this.state.settings?.site } }
  setSite(patch: SiteSettings): SiteSettings {
    const next = { ...this.state.settings?.site, ...patch }
    this.state.settings = { ...this.state.settings, site: next }
    this.save()
    return { ...next }
  }
  get(id: string): SavedDevice {
    const d = Object.hasOwn(this.state.devices, id) ? this.state.devices[id] : undefined
    if (!d) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (d.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    return d
  }
  /** Devices owned by one account, revoked ones excluded. */
  list(account: string): SavedDevice[] {
    const owner = accountKey(account)
    return Object.values(this.state.devices).filter(d => !d.revoked && d.account === owner)
  }
  register(descriptor: AccountDeviceDescriptor, account: string): ReturnType<Store['issue']> {
    const owner = accountKey(account)
    if (!Object.hasOwn(this.state.accounts, owner)) throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    const old = this.state.devices[descriptor.deviceId]
    if (old?.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    if (old && old.account !== owner) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    if (old && (old.descriptor.identityKey !== descriptor.identityKey || old.descriptor.role !== descriptor.role)) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    if (!old && this.list(owner).length >= ACCOUNT_MAX_DEVICES) throw new ApiError('RATE_LIMITED', 429)
    this.state.devices[descriptor.deviceId] = { descriptor, revoked: false, lastSeenAt: old?.lastSeenAt ?? 0, account: owner }
    this.invalidate(descriptor.deviceId)
    return this.issue(descriptor.deviceId, owner)
  }
  private issue(deviceId: string, account: string, refreshTokenExpiresAt = Date.now() + 30 * 86400_000) {
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.expires <= Date.now()) delete this.state.tokens[key]
    if (Object.keys(this.state.tokens).length >= ACCOUNT_MAX_TOKENS * Math.max(1, this.accountCount())) throw new ApiError('RATE_LIMITED', 429)
    const accessToken = secret(), refreshToken = secret()
    const accessTokenExpiresAt = Date.now() + 60 * 60_000
    this.state.tokens[hash(accessToken)] = { kind: 'access', deviceId, account, expires: accessTokenExpiresAt, used: false }
    this.state.tokens[hash(refreshToken)] = { kind: 'refresh', deviceId, account, expires: refreshTokenExpiresAt, used: false }
    this.save()
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
  }
  authenticate(token: string): SavedDevice {
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'access') throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    const device = this.get(record.deviceId)
    // A token minted before a device moved accounts cannot outlive the move.
    if (device.account !== record.account) throw new ApiError('AUTH_INVALID', 401)
    return device
  }
  refresh(deviceId: string, token: string) {
    const device = this.get(deviceId)
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'refresh' || record.deviceId !== deviceId || record.account !== device.account) throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    if (record.used) { this.invalidate(deviceId); throw new ApiError('AUTH_INVALID', 401) }
    record.used = true
    return this.issue(deviceId, device.account, record.expires)
  }
  invalidate(deviceId: string): void {
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.deviceId === deviceId) delete this.state.tokens[key]
    this.onInvalidate(deviceId)
    this.save()
  }
  revoke(id: string): void { this.get(id).revoked = true; this.invalidate(id) }
  /** Delete a device record outright, so reinstalling can register the same id again. */
  remove(id: string, account: string): void {
    const device = this.get(id)
    if (device.account !== accountKey(account)) throw new ApiError('DEVICE_NOT_FOUND', 404)
    delete this.state.devices[id]
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.deviceId === id) delete this.state.tokens[key]
    this.save()
    this.onInvalidate(id)
  }
  rename(id: string, name: string): void {
    this.get(id).descriptor.name = name
    this.save()
  }
  touch(id: string, clientVersion?: string, harnessVersion?: string): void {
    const d = this.get(id)
    d.lastSeenAt = Date.now()
    if (clientVersion) d.descriptor.clientVersion = clientVersion.slice(0, 64)
    if (d.descriptor.role === 'host' && harnessVersion) d.descriptor.harnessVersion = harnessVersion.slice(0, 64)
    this.save()
  }
}
