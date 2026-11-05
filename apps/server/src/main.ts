import { resolve } from 'node:path'
import {
  createRemoteServer,
  parseHelloTimeout,
  parseHeartbeatInterval,
  parseHeartbeatDisconnect,
  parseForceTerminateGrace,
} from './server.js'
import { parseLogLevel } from './logger.js'
import { parseIceConfig } from './ice.js'

const port = Number(process.env.DSH_SERVER_PORT ?? '8080')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DSH_SERVER_PORT.')

const heartbeatIntervalMs = parseHeartbeatInterval(process.env.DSH_SERVER_HEARTBEAT_INTERVAL_MS)
const heartbeatDisconnectMs = parseHeartbeatDisconnect(process.env.DSH_SERVER_HEARTBEAT_DISCONNECT_MS, heartbeatIntervalMs)
const helloTimeoutMs = parseHelloTimeout(process.env.DSH_SERVER_HELLO_TIMEOUT_MS)
const forceTerminateGraceMs = parseForceTerminateGrace(process.env.DSH_SERVER_FORCE_TERMINATE_GRACE_MS)
const logLevel = parseLogLevel(process.env.DSH_SERVER_LOG_LEVEL)

/** Registration is open unless the deployment turns it off; an invite code gates it further. */
const allowRegistration = !['0', 'false', 'no', 'off'].includes((process.env.DSH_SERVER_ALLOW_REGISTRATION ?? 'true').trim().toLowerCase())
/** SMTP defaults; the administrator console can override any field. */
const smtpPort = Number(process.env.DSH_SERVER_SMTP_PORT ?? '')
const smtpHost = process.env.DSH_SERVER_SMTP_HOST?.trim() ?? ''
const envSmtp = {
  ...(smtpHost === '' ? {} : { host: smtpHost }),
  ...(Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535 ? { port: smtpPort } : {}),
  ...(process.env.DSH_SERVER_SMTP_SECURE === undefined ? {} : { secure: !['0', 'false', 'no', 'off'].includes(process.env.DSH_SERVER_SMTP_SECURE.trim().toLowerCase()) }),
  ...(process.env.DSH_SERVER_SMTP_USER === undefined ? {} : { user: process.env.DSH_SERVER_SMTP_USER }),
  ...(process.env.DSH_SERVER_SMTP_PASS === undefined ? {} : { pass: process.env.DSH_SERVER_SMTP_PASS }),
  ...(process.env.DSH_SERVER_SMTP_FROM === undefined ? {} : { from: process.env.DSH_SERVER_SMTP_FROM }),
  enabled: !['0', 'false', 'no', 'off'].includes((process.env.DSH_SERVER_SMTP_ENABLED ?? (smtpHost === '' ? 'false' : 'true')).trim().toLowerCase()),
}
const parsedMaxAccounts = Number(process.env.DSH_SERVER_MAX_ACCOUNTS ?? '256')
const maxAccounts = Number.isInteger(parsedMaxAccounts) && parsedMaxAccounts >= 1 && parsedMaxAccounts <= 10_000 ? parsedMaxAccounts : 256

const app = createRemoteServer({
  account: process.env.DSH_SERVER_ACCOUNT ?? '',
  password: process.env.DSH_SERVER_PASSWORD ?? '',
  publicUrl: process.env.DSH_SERVER_PUBLIC_URL ?? `http://localhost:${port}`,
  dataFile: resolve(process.env.DSH_SERVER_DATA_FILE ?? 'data/state.json'),
  trustedProxyIps: (process.env.DSH_SERVER_TRUSTED_PROXY_IPS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  helloTimeoutMs,
  heartbeatIntervalMs,
  heartbeatDisconnectMs,
  forceTerminateGraceMs,
  logLevel,
  ice: parseIceConfig(process.env),
  allowRegistration,
  registrationCode: process.env.DSH_SERVER_REGISTRATION_CODE ?? '',
  maxAccounts,
  smtp: envSmtp,
})
app.server.listen(port, process.env.DSH_SERVER_HOST ?? '127.0.0.1', () => console.info(`Remote Server listening on port ${port}`))
app.server.on('error', () => { console.error('Remote Server could not listen. Check address and port.'); process.exitCode = 1; app.gateway.close() })
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  void app.close().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 })
})
