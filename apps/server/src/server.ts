import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomInt, randomUUID } from 'node:crypto'
import { arch, cpus, freemem, loadavg, platform, totalmem, uptime } from 'node:os'
import { isIP } from 'node:net'
import { z } from 'zod'
import { deviceRegistrationRequestSchema, deviceRefreshRequestSchema } from '@dsh-remote/protocol'
import { ApiError, Store, accountKey, equal, hash, secret, validEmail, validUsername, type SmtpSettings } from './store.js'
import { sendMail as defaultSendMail, smtpConfigured, verifySmtp, type MailSender } from './mailer.js'
import { Gateway } from './gateway.js'
import { buildIceServers, parseIceConfig, type IceConfig } from './ice.js'
import { Logger, type LogLevel } from './logger.js'
import {
  FORCE_TERMINATE_GRACE_MS_RANGE,
  HEARTBEAT_DISCONNECT_MS_MAX,
  HELLO_TIMEOUT_MS_RANGE,
  HEARTBEAT_INTERVAL_MS_RANGE,
  normalizeForceTerminateGraceMs,
  normalizeGatewayOptions,
  normalizeHeartbeatDisconnectMs,
  normalizeHeartbeatIntervalMs,
  normalizeHelloTimeoutMs,
} from './config.js'

export interface Config {
  /** Bootstrap identity, created (or re-keyed) on start; not the only account. */
  account: string
  password: string
  dataFile: string
  publicUrl: string
  /** Accept self-service registrations. Defaults to true. */
  allowRegistration?: boolean
  /** When set, registration also requires this invite code. */
  registrationCode?: string
  /** Upper bound on stored accounts. Defaults to 256. */
  maxAccounts?: number
  /** Injectable mail transport; tests replace it, production uses SMTP. */
  sendMail?: MailSender
  /** SMTP defaults from the environment; the console can override them. */
  smtp?: SmtpSettings
  /** Email-code login policy: 'off', 'optional' (default) or 'required'. */
  emailLogin?: 'off' | 'optional' | 'required'
  /** Address bound to the bootstrap administrator on start. */
  accountEmail?: string
  trustedProxyIps?: readonly string[]
  helloTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatDisconnectMs?: number
  forceTerminateGraceMs?: number
  logLevel?: LogLevel
  ice?: IceConfig
}

/**
 * Timing configuration is normalized in one place (`config.ts`) so the CLI and
 * programmatic callers share the same bounds and fallbacks. These wrappers keep
 * the env-var parsing API used by `main.ts` and the tests, and never echo the
 * offending input in their warnings.
 */
export function parseHelloTimeout(val: string | undefined): number {
  return normalizeHelloTimeoutMs(val)
}

export function parseHeartbeatInterval(val: string | undefined): number {
  return normalizeHeartbeatIntervalMs(val)
}

export function parseHeartbeatDisconnect(val: string | undefined, heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS_RANGE.fallback): number {
  return normalizeHeartbeatDisconnectMs(val, heartbeatIntervalMs)
}

export function parseForceTerminateGrace(val: string | undefined): number {
  return normalizeForceTerminateGraceMs(val)
}

export {
  normalizeGatewayOptions,
  normalizeHelloTimeoutMs,
  normalizeHeartbeatIntervalMs,
  normalizeHeartbeatDisconnectMs,
  normalizeForceTerminateGraceMs,
  HELLO_TIMEOUT_MS_RANGE,
  HEARTBEAT_INTERVAL_MS_RANGE,
  HEARTBEAT_DISCONNECT_MS_MAX,
  FORCE_TERMINATE_GRACE_MS_RANGE,
}
export type { GatewayTimingOptions, NormalizedGatewayOptions } from './config.js'

const loginSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().max(1024).optional(),
  code: z.string().max(16).optional(),
}).strict()
const loginCodeSchema = z.object({ email: z.string().min(1).max(254) }).strict()
const registerSchema = z.object({
  username: z.string().min(1).max(64).optional(),
  /** Registration mailbox; required (and verified) once SMTP is configured. */
  email: z.string().max(254).optional(),
  /** Email verification code. */
  code: z.string().max(16).optional(),
  inviteCode: z.string().max(256).optional(),
  password: z.string().min(1).max(1024),
}).strict()
const registerCodeSchema = z.object({ email: z.string().min(1).max(254) }).strict()
const forgotSchema = z.object({ email: z.string().min(1).max(254) }).strict()
const resetSchema = z.object({ email: z.string().min(1).max(254), code: z.string().min(1).max(16), password: z.string().min(1).max(1024) }).strict()
const emailCodeSchema = z.object({ email: z.string().min(1).max(254) }).strict()
const bindEmailSchema = z.object({ email: z.string().min(1).max(254), code: z.string().min(1).max(16) }).strict()
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(1024), password: z.string().min(1).max(1024) }).strict()
const smtpSchema = z.object({
  enabled: z.boolean().optional(),
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  user: z.string().max(255).optional(),
  pass: z.string().max(512).optional(),
  from: z.string().max(255).optional(),
}).strict()
const siteSchema = z.object({
  name: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  announcement: z.string().max(2000).optional(),
  footer: z.string().max(500).optional(),
}).strict()
const accountFlagSchema = z.object({ disabled: z.boolean() }).strict()
const EMAIL_CODE_TTL_MS = 10 * 60_000
const EMAIL_CODE_MAX_ATTEMPTS = 5
const publicDir = fileURLToPath(new URL('../dist/public/', import.meta.url))
function readAssets(): Map<string, Buffer> {
  if (!existsSync(publicDir)) return new Map()
  const assets = new Map<string, Buffer>()
  for (const entry of readdirSync(publicDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    const path = file.slice(publicDir.length).replaceAll('\\', '/')
    assets.set(path, readFileSync(file))
  }
  return assets
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError('INVALID_MESSAGE', 415)
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > 16384) throw new ApiError('FRAME_TOO_LARGE', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ApiError('INVALID_MESSAGE') }
}
/**
 * Normalize one bare IPv4/IPv6 literal to a single canonical form. IPv4-mapped
 * IPv6 addresses (e.g. ::ffff:127.0.0.1) collapse to plain IPv4, so a peer
 * observed through a dual-stack socket and a config entry compare equal.
 * Returns null for anything that is not a single IP literal: hostnames, ports,
 * CIDR ranges, comma-separated lists, bracketed hosts and zone identifiers.
 */
export function normalizeIp(value: string): string | null {
  const family = isIP(value)
  if (family === 4) return value.toLowerCase()
  if (family !== 6) return null
  let canonical: string
  try {
    canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  } catch { return null }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!mapped) return canonical
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16)
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}
/** Validate and normalize the trusted proxy list at startup. Empty means disabled. */
export function normalizeTrustedProxyIps(values: readonly string[] = []): ReadonlySet<string> {
  const result = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    const normalized = value === '' ? null : normalizeIp(value)
    if (normalized === null) throw new Error(`Invalid DSH_SERVER_TRUSTED_PROXY_IPS entry "${raw}": expected a bare IPv4/IPv6 address (no port, CIDR or hostname).`)
    result.add(normalized)
  }
  return result
}
function readSingleForwardedFor(req: IncomingMessage): string {
  let value: string | undefined
  let count = 0
  const raw = req.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() !== 'x-forwarded-for') continue
    count++
    value = raw[i + 1]
  }
  if (count !== 1) throw new ApiError('INVALID_MESSAGE')
  return value!
}
/**
 * Resolve the address used for rate limiting. X-Forwarded-For is honored only
 * when the socket peer is a configured trusted proxy; that peer must send one
 * header holding exactly one IP literal, otherwise the request is rejected.
 */
export function clientAddress(req: IncomingMessage, trustedProxyIps: ReadonlySet<string>): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? '')
  if (peer === null) throw new ApiError('INVALID_MESSAGE')
  if (!trustedProxyIps.has(peer)) return peer
  const forwarded = normalizeIp(readSingleForwardedFor(req))
  if (forwarded === null) throw new ApiError('INVALID_MESSAGE')
  return forwarded
}
export function createRemoteServer(config: Config) {
  if (!config.account.trim() || config.password.length < 12) throw new Error('DSH_SERVER_ACCOUNT and DSH_SERVER_PASSWORD (at least 12 characters) are required.')
  const url = new URL(config.publicUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('DSH_SERVER_PUBLIC_URL must be an HTTP(S) origin.')
  const trustedProxyIps = normalizeTrustedProxyIps(config.trustedProxyIps)
  const ice = config.ice ?? parseIceConfig({})
  const store = new Store(config.dataFile, config.account.trim(), config.password, config.maxAccounts ?? 256)
  const allowRegistration = config.allowRegistration !== false
  const emailLogin = config.emailLogin === 'off' || config.emailLogin === 'required' ? config.emailLogin : 'optional'
  const bootstrapEmail = config.accountEmail?.trim().toLowerCase() ?? ''
  if (bootstrapEmail !== '' && validEmail(bootstrapEmail)) {
    const bootstrap = accountKey(config.account)
    try {
      const current = store.descriptorOf(bootstrap)
      if (current.email !== bootstrapEmail) store.bindEmail(bootstrap, bootstrapEmail)
    } catch { /* the address already belongs to another account */ }
  }
  const registrationCode = config.registrationCode?.trim() ?? ''
  const mail = config.sendMail ?? defaultSendMail
  const startedAt = Date.now()
  const serverVersion = 'self-hosted/0.6.3'
  /** SMTP defaults from the environment; console values win field by field. */
  const envSmtp: SmtpSettings = config.smtp ?? {}
  function effectiveSmtp(): SmtpSettings {
    const stored = store.smtp()
    const merged: SmtpSettings = { ...envSmtp }
    for (const [key, value] of Object.entries(stored)) {
      if (value === undefined || value === '') continue
      ;(merged as Record<string, unknown>)[key] = value
    }
    return merged
  }
  const smtpSource = (): 'env' | 'settings' | 'none' => {
    const stored = store.smtp()
    const hasStored = Object.values(stored).some(value => value !== undefined && value !== '')
    if (hasStored) return 'settings'
    return smtpConfigured(envSmtp) ? 'env' : 'none'
  }
  /** Outstanding email verification codes: purpose key → code and expiry. */
  const emailCodes = new Map<string, { code: string; expires: number; attempts: number }>()
  function issueEmailCode(key: string): string {
    for (const [stored, entry] of emailCodes) if (entry.expires <= Date.now()) emailCodes.delete(stored)
    if (emailCodes.size >= 4096) throw new ApiError('RATE_LIMITED', 429)
    // Cryptographically random six digits: the code is not derived from a clock.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    emailCodes.set(key, { code, expires: Date.now() + EMAIL_CODE_TTL_MS, attempts: 0 })
    return code
  }
  function checkEmailCode(key: string, code: string): boolean {
    const entry = emailCodes.get(key)
    if (entry === undefined) return false
    if (entry.expires <= Date.now()) { emailCodes.delete(key); return false }
    if (++entry.attempts > EMAIL_CODE_MAX_ATTEMPTS) { emailCodes.delete(key); return false }
    if (!equal(entry.code, code.trim())) return false
    emailCodes.delete(key)
    return true
  }
  const siteInfo = () => {
    const site = store.site()
    const smtp = effectiveSmtp()
    return {
      name: site.name ?? 'DeepSeek Harness Remote',
      description: site.description ?? 'DeepSeek Harness 的自建远程中继：Host 与客户端端到端加密连接。',
      announcement: site.announcement ?? '',
      footer: site.footer ?? '',
      registration: { enabled: allowRegistration, requiresCode: registrationCode !== '' },
      email: { enabled: smtpConfigured(smtp), verificationRequired: allowRegistration && smtpConfigured(smtp) },
      login: { emailCode: smtpConfigured(smtp) ? emailLogin : 'off' as const },
    }
  }
  const mailBrand = () => store.site().name ?? 'DeepSeek Harness Remote'
  async function sendCodeMail(to: string, code: string, purpose: string): Promise<void> {
    const smtp = effectiveSmtp()
    if (!smtpConfigured(smtp)) throw new ApiError('SMTP_NOT_CONFIGURED', 400)
    await mail(smtp, { subject: `[${mailBrand()}] ${purpose}`, to, text: `你的验证码是 ${code}，10 分钟内有效。如果这不是你本人操作，请忽略这封邮件。` })
  }
  /** Sampling state for the console charts; driven by console requests, no timer. */
  const metrics = {
    cpu: { at: 0, idle: 0, total: 0 },
    traffic: { at: Date.now(), rx: 0, tx: 0 },
    history: [] as { t: number; rx: number; tx: number }[],
  }
  function cpuUsagePercent(): number {
    let idle = 0, total = 0
    for (const cpu of cpus()) {
      const times = cpu.times
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }
    const previous = metrics.cpu
    metrics.cpu = { at: Date.now(), idle, total }
    if (previous.at === 0 || total <= previous.total) return 0
    const idleDelta = idle - previous.idle
    const totalDelta = total - previous.total
    return totalDelta <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)))
  }
  function trafficSample(): { rx: number; tx: number } {
    const now = Date.now()
    const seconds = Math.max(1, (now - metrics.traffic.at) / 1000)
    const rx = Math.max(0, (gateway.traffic.rxBytes - metrics.traffic.rx) / seconds)
    const tx = Math.max(0, (gateway.traffic.txBytes - metrics.traffic.tx) / seconds)
    metrics.traffic = { at: now, rx: gateway.traffic.rxBytes, tx: gateway.traffic.txBytes }
    metrics.history.push({ t: now, rx: Math.round(rx), tx: Math.round(tx) })
    if (metrics.history.length > 120) metrics.history.shift()
    return { rx: Math.round(rx), tx: Math.round(tx) }
  }
  function systemSnapshot() {
    const memTotal = totalmem(), memFree = freemem()
    let disk = { total: 0, free: 0, usedPercent: 0 }
    try {
      const stats = statfsSync('/')
      const total = stats.blocks * stats.bsize
      const free = stats.bavail * stats.bsize
      disk = { total, free, usedPercent: total > 0 ? Math.round((1 - free / total) * 100) : 0 }
    } catch { /* statfs is unavailable on some platforms */ }
    return {
      platform: platform(),
      arch: arch(),
      cpuCount: cpus().length,
      cpuUsage: cpuUsagePercent(),
      load: loadavg().map(value => Math.round(value * 100) / 100),
      memory: { total: memTotal, free: memFree, usedPercent: memTotal > 0 ? Math.round((1 - memFree / memTotal) * 100) : 0 },
      disk,
      nodeVersion: process.version,
      hostUptimeSeconds: Math.round(uptime()),
      processUptimeSeconds: Math.round(process.uptime()),
    }
  }
  const assets = readAssets()
  /** Account sessions: cookie value digest → owning account and expiry. */
  const sessions = new Map<string, { account: string; expires: number }>()
  const limits = new Map<string, { count: number; until: number }>()
  function rate(key: string, max: number) {
    for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k)
    let entry = limits.get(key)
    if (!entry) { if (limits.size >= 4096) throw new ApiError('RATE_LIMITED', 429); entry = { count: 0, until: Date.now() + 60_000 }; limits.set(key, entry) }
    if (++entry.count > max) throw new ApiError('RATE_LIMITED', 429)
  }
  function token(req: IncomingMessage): string {
    const authorization = req.headers.authorization
    if (authorization) return authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    return /(?:^|;\s*)dsh_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  }
  /** Resolve the signed-in account, or fail closed. */
  function accountAuth(req: IncomingMessage): string {
    const key = hash(token(req))
    const session = sessions.get(key)
    if (session === undefined || session.expires <= Date.now()) { sessions.delete(key); throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401) }
    return session.account
  }
  /** Open a session for one account and issue the cookie value. */
  function startSession(account: string): { value: string; expiresAt: number } {
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key)
    if (sessions.size >= 1024) throw new ApiError('RATE_LIMITED', 429)
    const value = secret(), expiresAt = Date.now() + 8 * 3600_000
    sessions.set(hash(value), { account, expires: expiresAt })
    return { value, expiresAt }
  }
  function deviceAuth(req: IncomingMessage) {
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new ApiError('AUTH_REQUIRED', 401)
    return store.authenticate(req.headers.authorization.slice(7))
  }
  function cookie(value: string, age: number): string { return `dsh_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}` }
  const profile = (account: string) => {
    const descriptor = store.descriptorOf(account)
    return {
      account,
      profile: { displayName: account },
      isAdmin: descriptor.role === 'admin',
      role: descriptor.role,
      ...(descriptor.email === undefined ? {} : { email: descriptor.email }),
      emailVerified: descriptor.emailVerified,
    }
  }
  /** Console access: any signed-in account, then an administrator check. */
  function adminAuth(req: IncomingMessage): string {
    const account = accountAuth(req)
    if (!store.isAdmin(account)) throw new ApiError('ADMIN_REQUIRED', 403)
    return account
  }
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    void route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return
      const e = error instanceof ApiError ? error : error instanceof z.ZodError ? new ApiError('INVALID_MESSAGE') : new ApiError('INTERNAL_ERROR', 500)
      if (e.status === 429) res.setHeader('Retry-After', '60')
      json(res, e.status, { error: { code: e.code, message: e.code, requestId: randomUUID(), retryable: e.status === 429 || e.status >= 500 } })
    })
  })
  const logger = new Logger('server', config.logLevel ?? 'info')
  // Normalize at this boundary as well: a programmatic caller may pass NaN,
  // Infinity or a negative value straight through the Config object.
  const timing = normalizeGatewayOptions({
    helloTimeoutMs: config.helloTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatDisconnectMs: config.heartbeatDisconnectMs,
    forceTerminateGraceMs: config.forceTerminateGraceMs,
  })
  const gateway = new Gateway(server, store, url.origin, {
    ...timing,
    logLevel: config.logLevel,
    logger: logger.child('gateway'),
    turnEnabled: ice.turnUrls.length > 0,
  })
  function descriptor(d: ReturnType<Store['get']>) {
    return { ...d.descriptor, membershipId: `account:${hash(d.account).slice(0, 16)}`, online: gateway.peers.has(d.descriptor.deviceId), lastSeenAt: d.lastSeenAt }
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const requestUrl = new URL(req.url ?? '/', url)
    const path = requestUrl.pathname
    const method = req.method
    if (req.headers.origin && req.headers.origin !== url.origin) throw new ApiError('AUTH_INVALID', 403)
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('AUTH_INVALID', 403)
    const staticAsset = path.startsWith('/assets/') || ['/icon.png', '/brand-whale.webp', '/landing-atmosphere.webp'].includes(path)
    // SPA fallback: any GET that is not API / WebSocket / health-check returns index.html.
    // Without this, refreshing a client route such as /app/remote hits the unknown-method branch and yields METHOD_NOT_FOUND.
    const spaRoute = method === 'GET' && !staticAsset && !path.startsWith('/api/') && !path.startsWith('/ws/') && !['/health', '/healthz', '/ready'].includes(path)
    if (method === 'GET' && (spaRoute || staticAsset)) {
      const name = staticAsset ? path.slice(1) : 'index.html'
      const asset = assets.get(name)
      if (!asset) throw new ApiError('METHOD_NOT_FOUND', 404)
      const contentType = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'text/html; charset=utf-8'
      if (!staticAsset) res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Content-Type', contentType)
      res.end(asset); return
    }
    if (method === 'GET' && (path === '/health' || path === '/healthz' || path === '/ready')) { json(res, 200, { status: 'ok' }); return }
    const client = clientAddress(req, trustedProxyIps)
    rate(`api:${client}`, 240)
    if (method === 'GET' && path === '/api/v1/site') { json(res, 200, siteInfo()); return }
    if (method === 'GET' && path === '/api/v1/auth/registration') {
      // Public: the sign-in page needs to know whether to offer a register tab.
      json(res, 200, { enabled: allowRegistration, requiresCode: registrationCode !== '' }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/login/code') {
      rate(`login-code:${client}`, 5)
      if (emailLogin === 'off') throw new ApiError('EMAIL_LOGIN_DISABLED', 403)
      const request = loginCodeSchema.parse(await body(req))
      const account = store.accountByEmail(request.email)
      // Answer identically for unknown addresses: account membership is not public.
      if (account !== null) {
        const code = issueEmailCode(`login:${account}`)
        await sendCodeMail(request.email.trim().toLowerCase(), code, '登录验证码')
      }
      json(res, 200, { status: 'ok' }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/login') {
      rate(`login:${client}`, 20)
      const credentials = loginSchema.parse(await body(req))
      const useCode = credentials.code !== undefined && credentials.code.trim() !== ''
      let account: string | null
      if (useCode) {
        if (emailLogin === 'off') throw new ApiError('EMAIL_LOGIN_DISABLED', 403)
        const owner = store.accountByEmail(credentials.email)
        if (owner === null || !checkEmailCode(`login:${owner}`, credentials.code!)) throw new ApiError('CODE_INVALID', 400)
        account = owner
      } else {
        if (emailLogin === 'required') throw new ApiError('EMAIL_CODE_REQUIRED', 403)
        // Accept a username or a verified email: the store resolves the identifier.
        account = store.verify(credentials.email, credentials.password ?? '')
        if (account === null) throw new ApiError('AUTH_INVALID', 401)
      }
      const session = startSession(account)
      res.setHeader('Set-Cookie', cookie(session.value, 8 * 3600))
      json(res, 200, { ...profile(account), token: session.value, expiresAt: session.expiresAt }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/register/code') {
      if (!allowRegistration) throw new ApiError('REGISTRATION_CLOSED', 403)
      rate(`register-code:${client}`, 5)
      const request = registerCodeSchema.parse(await body(req))
      const email = request.email.trim().toLowerCase()
      if (!validEmail(email)) throw new ApiError('INVALID_EMAIL', 400)
      if (store.accountByEmail(email) !== null) throw new ApiError('EMAIL_IN_USE', 409)
      const code = issueEmailCode(`register:${email}`)
      await sendCodeMail(email, code, '注册验证码')
      json(res, 200, { status: 'ok' }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/register') {
      if (!allowRegistration) throw new ApiError('REGISTRATION_CLOSED', 403)
      rate(`register:${client}`, 10)
      const request = registerSchema.parse(await body(req))
      if (registrationCode !== '' && !equal(request.inviteCode?.trim() ?? '', registrationCode)) throw new ApiError('REGISTRATION_CODE_INVALID', 403)
      const smtp = effectiveSmtp()
      const emailRequired = smtpConfigured(smtp)
      // Older clients send the account name in `email`. That legacy shape never
      // carried a mailbox, so it is read as a username and not format-checked.
      const legacyNameOnly = request.username === undefined && !emailRequired
      const username = (request.username ?? (legacyNameOnly ? (request.email ?? '') : '')).trim()
      if (username === '') throw new ApiError('INVALID_ACCOUNT')
      const email = legacyNameOnly ? '' : (request.email?.trim().toLowerCase() ?? '')
      if (emailRequired) {
        if (!validEmail(email)) throw new ApiError('INVALID_EMAIL', 400)
        if (store.accountByEmail(email) !== null) throw new ApiError('EMAIL_IN_USE', 409)
        if (!checkEmailCode(`register:${email}`, request.code ?? '')) throw new ApiError('CODE_INVALID', 400)
      } else if (email !== '' && !validEmail(email)) {
        throw new ApiError('INVALID_EMAIL', 400)
      }
      const account = store.createAccount(username, request.password)
      if (emailRequired) store.bindEmail(account, email)
      const session = startSession(account)
      res.setHeader('Set-Cookie', cookie(session.value, 8 * 3600))
      json(res, 200, { ...profile(account), token: session.value, expiresAt: session.expiresAt }); return
    }
    if (method === 'GET' && path === '/api/v1/auth/me') { json(res, 200, profile(accountAuth(req))); return }
    if (method === 'POST' && path === '/api/v1/auth/logout') {
      sessions.delete(hash(token(req))); res.setHeader('Set-Cookie', cookie('', 0)); json(res, 200, { status: 'ok' }); return
    }
    if (method === 'GET' && path === '/api/v1/account/devices') {
      const account = accountAuth(req)
      json(res, 200, { items: store.list(account).map(descriptor), serverUrl: url.origin, transport: 'webrtc' }); return
    }
    if (method === 'POST' && (path === '/api/v1/devices/register' || path === '/api/v1/devices/register-owned-role')) {
      const source = path.endsWith('register-owned-role') ? deviceAuth(req) : undefined
      const account = source === undefined ? accountAuth(req) : source.account
      const { device } = deviceRegistrationRequestSchema.parse(await body(req))
      if (source && (source.descriptor.deviceId === device.deviceId || source.descriptor.role === device.role)) throw new ApiError('INVALID_MESSAGE', 409)
      json(res, 200, store.register(device, account)); return
    }
    if (method === 'POST' && path === '/api/v1/auth/refresh') {
      const data = deviceRefreshRequestSchema.parse(await body(req))
      json(res, 200, store.refresh(data.deviceId, data.refreshToken)); return
    }
    if (method === 'DELETE' && path === '/api/v1/devices/self') {
      store.revoke(deviceAuth(req).descriptor.deviceId); json(res, 200, { status: 'revoked' }); return
    }
    if (method === 'GET' && path === '/api/v1/me') { json(res, 200, descriptor(deviceAuth(req))); return }
    if (method === 'GET' && path === '/api/v1/turn/credentials') {
      const source = deviceAuth(req)
      const connectionId = requestUrl.searchParams.get('connection_id') ?? ''
      if (!connectionId || connectionId.length > 128) throw new ApiError('INVALID_MESSAGE')
      if (!gateway.authorizeIce(source.descriptor.deviceId, connectionId)) throw new ApiError('CONNECTION_NOT_FOUND', 404)
      json(res, 200, { iceServers: buildIceServers(ice, source.descriptor.deviceId) }); return
    }
    if (method === 'GET' && path === '/api/v1/devices') {
      const source = deviceAuth(req)
      if (source.descriptor.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
      const items = store.list(source.account).filter(d => d.descriptor.role === 'host').map(d => {
        const { identityKey: _key, ...item } = descriptor(d)
        return item
      })
      json(res, 200, { items, nextCursor: null }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/password/forgot') {
      rate(`forgot:${client}`, 10)
      const request = forgotSchema.parse(await body(req))
      const account = store.accountByEmail(request.email)
      // Answer the same way whether or not the address is bound: membership is
      // not something an anonymous caller gets to probe.
      if (account === null) { json(res, 200, { status: 'ok' }); return }
      const code = issueEmailCode(`password:${account}`)
      await sendCodeMail(request.email.trim().toLowerCase(), code, '密码重置验证码')
      json(res, 200, { status: 'ok' }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/password/reset') {
      rate(`reset:${client}`, 10)
      const request = resetSchema.parse(await body(req))
      const account = store.accountByEmail(request.email)
      if (account === null || !checkEmailCode(`password:${account}`, request.code)) throw new ApiError('CODE_INVALID', 400)
      store.setPassword(account, request.password)
      json(res, 200, { status: 'ok' }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/password') {
      const account = accountAuth(req)
      rate(`password:${client}`, 10)
      const request = changePasswordSchema.parse(await body(req))
      if (store.verify(account, request.currentPassword) === null) throw new ApiError('AUTH_INVALID', 401)
      store.setPassword(account, request.password)
      json(res, 200, { status: 'ok' }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/email/code') {
      const account = accountAuth(req)
      rate(`email-code:${client}`, 5)
      const request = emailCodeSchema.parse(await body(req))
      const email = request.email.trim().toLowerCase()
      if (!validEmail(email)) throw new ApiError('INVALID_EMAIL', 400)
      const code = issueEmailCode(`bind:${account}`)
      await sendCodeMail(email, code, '邮箱绑定验证码')
      json(res, 200, { status: 'ok' }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/email/bind') {
      const account = accountAuth(req)
      const request = bindEmailSchema.parse(await body(req))
      const email = request.email.trim().toLowerCase()
      if (!checkEmailCode(`bind:${account}`, request.code)) throw new ApiError('CODE_INVALID', 400)
      store.bindEmail(account, email)
      json(res, 200, profile(account)); return
    }
    if (path.startsWith('/api/v1/admin/')) {
      const admin = adminAuth(req)
      const overview = () => {
        const accounts = store.listAccounts()
        const devices = accounts.flatMap(entry => store.list(entry.account))
        const online = (device: { descriptor: { deviceId: string } }) => gateway.peers.has(device.descriptor.deviceId)
        const hosts = devices.filter(device => device.descriptor.role === 'host')
        const clients = devices.filter(device => device.descriptor.role === 'client')
        const rates = trafficSample()
        const smtp = effectiveSmtp()
        return {
          version: serverVersion,
          startedAt,
          uptimeMs: Date.now() - startedAt,
          serverUrl: url.origin,
          accounts: {
            total: accounts.length,
            admins: accounts.filter(entry => entry.role === 'admin').length,
            users: accounts.filter(entry => entry.role !== 'admin').length,
          },
          devices: {
            total: devices.length,
            online: devices.filter(online).length,
            hosts: hosts.length,
            hostsOnline: hosts.filter(online).length,
            clients: clients.length,
            clientsOnline: clients.filter(online).length,
          },
          network: {
            rxBytes: gateway.traffic.rxBytes,
            txBytes: gateway.traffic.txBytes,
            rxRate: rates.rx,
            txRate: rates.tx,
            peers: gateway.peers.size,
            history: [...metrics.history],
          },
          system: systemSnapshot(),
          email: { enabled: smtpConfigured(smtp), source: smtpSource(), verificationRequired: smtpConfigured(smtp) && allowRegistration },
          registration: { enabled: allowRegistration, requiresCode: registrationCode !== '' },
        }
      }
      if (method === 'GET' && path === '/api/v1/admin/overview') { json(res, 200, overview()); return }
      if (method === 'GET' && path === '/api/v1/admin/accounts') { json(res, 200, { items: store.listAccounts(), current: admin }); return }
      const flagMatch = /^\/api\/v1\/admin\/accounts\/([^/]+)\/disabled$/.exec(path)
      if (method === 'POST' && flagMatch) {
        const target = accountKey(decodeURIComponent(flagMatch[1]!))
        if (target === admin) throw new ApiError('SELF_FORBIDDEN', 409)
        const { disabled } = accountFlagSchema.parse(await body(req))
        store.setDisabled(target, disabled)
        json(res, 200, store.descriptorOf(target)); return
      }
      const accountMatch = /^\/api\/v1\/admin\/accounts\/([^/]+)$/.exec(path)
      if (method === 'DELETE' && accountMatch) {
        const target = accountKey(decodeURIComponent(accountMatch[1]!))
        if (target === admin) throw new ApiError('SELF_FORBIDDEN', 409)
        store.deleteAccount(target)
        json(res, 200, { status: 'deleted' }); return
      }
      if (path === '/api/v1/admin/smtp') {
        if (method === 'GET') {
          const effective = effectiveSmtp()
          // Never echo the stored password; the form only needs to know it is set.
          json(res, 200, { ...effective, pass: effective.pass ? '********' : '', source: smtpSource() })
          return
        }
        if (method === 'PUT' || method === 'POST') {
          const patch = smtpSchema.parse(await body(req)) as SmtpSettings
          if (patch.pass === '********') delete patch.pass
          const saved = store.setSmtp(patch)
          json(res, 200, { ...saved, pass: saved.pass ? '********' : '', source: smtpSource() }); return
        }
      }
      if (method === 'POST' && path === '/api/v1/admin/smtp/test') {
        try {
          await verifySmtp(effectiveSmtp())
          json(res, 200, { status: 'ok' })
        } catch (error) {
          json(res, 400, { error: { code: 'SMTP_FAILED', message: error instanceof Error ? error.message : 'SMTP verification failed', retryable: false } })
        }
        return
      }
      if (path === '/api/v1/admin/site') {
        if (method === 'GET') { json(res, 200, { ...siteInfo(), site: store.site() }); return }
        if (method === 'PUT' || method === 'POST') {
          const patch = siteSchema.parse(await body(req))
          json(res, 200, store.setSite(patch)); return
        }
      }
      throw new ApiError('METHOD_NOT_FOUND', 404)
    }
    const renameMatch = /^\/api\/v1\/devices\/([^/]+)\/name$/.exec(path)
    if (method === 'POST' && renameMatch) {
      const account = accountAuth(req)
      const target = store.get(renameMatch[1]!)
      if (target.account !== account) throw new ApiError('DEVICE_NOT_FOUND', 404)
      const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await body(req))
      store.rename(renameMatch[1]!, name)
      json(res, 200, descriptor(store.get(renameMatch[1]!))); return
    }
    const match = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path)
    if (method === 'GET' && match) {
      const source = deviceAuth(req), target = store.get(match[1]!)
      if (source.account !== target.account) throw new ApiError('DEVICE_NOT_FOUND', 404)
      if (source.descriptor.role === target.descriptor.role) throw new ApiError('MEMBERSHIP_REQUIRED', 403)
      const d = descriptor(target)
      json(res, 200, match[2] ? { deviceId: d.deviceId, online: d.online, lastSeenAt: d.lastSeenAt } : d); return
    }
    throw new ApiError('METHOD_NOT_FOUND', 404)
  }
  return { server, store, gateway, logger, close: async () => { gateway.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value))
}
