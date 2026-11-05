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
/** Per-account device and token caps; the global caps scale with the account count. */
const ACCOUNT_MAX_DEVICES = 256
const ACCOUNT_MAX_TOKENS = 16_384
const ACCOUNT_EMAIL_MAX_LENGTH = 254
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Salt used when an unknown account is probed, so a miss costs the same work as a hit. */
const UNKNOWN_ACCOUNT_SALT = 'unknown-account'

/**
 * Canonical account key. Addresses are stored and compared in one casing, so a
 * login with a different case cannot fork a second identity for one mailbox.
 */
export const accountKey = (email: string): string => email.trim().toLowerCase()

export function validAccountKey(account: string): boolean {
  return account.length > 0 && account.length <= ACCOUNT_EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(account)
}

const accountRecordSchema = z.object({ salt: z.string(), verifier: z.string(), createdAt: z.number() })
const tokenSchema = z.object({ kind: z.enum(['access', 'refresh']), deviceId: z.string(), account: z.string(), expires: z.number(), used: z.boolean() })
const savedDeviceSchema = z.object({ descriptor: accountDeviceDescriptorSchema, revoked: z.boolean(), lastSeenAt: z.number(), account: z.string() })
/** Current on-disk format: many accounts, each owning its own devices and tokens. */
const stateSchema = z.object({
  version: z.literal(2),
  accounts: z.record(z.string(), accountRecordSchema),
  devices: z.record(z.string(), savedDeviceSchema),
  tokens: z.record(z.string(), tokenSchema),
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
type SavedDevice = z.infer<typeof savedDeviceSchema>

/**
 * Single-process store. Only token digests and public identities reach disk.
 *
 * Accounts are independent: a device belongs to the account that registered it,
 * device tokens carry their owner, and nothing is listed across accounts. The
 * account/password passed from the environment is a bootstrap identity that is
 * created (or re-keyed) on start, not the only one the server accepts.
 */
export class Store {
  private readonly state: State
  onInvalidate: (id: string) => void = () => {}
  constructor(
    private readonly file: string,
    bootstrapAccount = '',
    bootstrapPassword = '',
    private readonly maxAccounts = 256,
  ) {
    this.state = this.load()
    const bootstrap = accountKey(bootstrapAccount)
    if (bootstrap !== '' && bootstrapPassword !== '') this.ensureBootstrapAccount(bootstrap, bootstrapPassword)
    this.save()
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
      accounts: { [account]: { salt: legacy.salt, verifier: legacy.verifier, createdAt: Date.now() } },
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
  private ensureBootstrapAccount(account: string, password: string): void {
    const existing = this.state.accounts[account]
    if (existing === undefined) {
      // The bootstrap account keeps its historical, looser contract: any non-empty
      // name is accepted so an existing deployment never fails to start.
      if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`DSH_SERVER_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters.`)
      const salt = this.createSalt()
      this.state.accounts[account] = { salt, verifier: this.verifyPassword(password, salt), createdAt: Date.now() }
      return
    }
    const verifier = this.verifyPassword(password, existing.salt)
    if (equal(verifier, existing.verifier)) return
    existing.verifier = verifier
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.account === account) delete this.state.tokens[key]
  }
  accountCount(): number { return Object.keys(this.state.accounts).length }
  accountExists(email: string): boolean { return Object.hasOwn(this.state.accounts, accountKey(email)) }
  /**
   * Register a new account. Callers decide policy (open registration, invite
   * code); the store enforces the identity and password contract.
   */
  createAccount(email: string, password: string): string {
    const account = accountKey(email)
    if (!validAccountKey(account)) throw new ApiError('INVALID_ACCOUNT')
    if (password.length < PASSWORD_MIN_LENGTH) throw new ApiError('WEAK_PASSWORD')
    if (Object.hasOwn(this.state.accounts, account)) throw new ApiError('ACCOUNT_EXISTS', 409)
    if (this.accountCount() >= this.maxAccounts) throw new ApiError('ACCOUNT_LIMIT_REACHED', 429)
    const salt = this.createSalt()
    this.state.accounts[account] = { salt, verifier: this.verifyPassword(password, salt), createdAt: Date.now() }
    this.save()
    return account
  }
  /** Constant-ish time: an unknown account still pays one scrypt derivation. */
  verify(email: string, password: string): boolean {
    const record = this.state.accounts[accountKey(email)]
    const verifier = this.verifyPassword(password, record?.salt ?? UNKNOWN_ACCOUNT_SALT)
    return record !== undefined && equal(verifier, record.verifier)
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
