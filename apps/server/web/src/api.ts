export interface Account {
  account: string
  role?: 'admin' | 'user'
  isAdmin?: boolean
  email?: string
  emailVerified?: boolean
}
export interface Device {
  deviceId: string; name: string; role: 'host' | 'client'; platform: string;
  clientVersion: string; harnessVersion?: string; online: boolean; lastSeenAt?: number;
}
export interface DeviceList { items: Device[]; serverUrl: string; transport: string }
export interface RegistrationInfo { enabled: boolean; requiresCode: boolean }
export interface SiteInfo {
  name: string
  description: string
  announcement: string
  footer: string
  registration: RegistrationInfo
}
export interface AdminOverview {
  version: string
  startedAt: number
  uptimeMs: number
  accounts: number
  admins: number
  devices: number
  onlineDevices: number
  hosts: number
  clients: number
  smtpConfigured: boolean
  registration: RegistrationInfo
  serverUrl: string
}
export interface AdminAccount {
  account: string
  role: 'admin' | 'user'
  email?: string
  emailVerified: boolean
  disabled: boolean
  createdAt: number
  devices: number
}
export interface SmtpSettings {
  enabled?: boolean
  host?: string
  port?: number
  secure?: boolean
  user?: string
  pass?: string
  from?: string
}
export interface SiteSettings {
  name?: string
  description?: string
  announcement?: string
  footer?: string
}
export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
const MESSAGES: Record<string, string> = {
  AUTH_INVALID: '账号或密码错误，请重试。',
  ACCOUNT_AUTH_REQUIRED: '登录已过期，请重新登录。',
  RATE_LIMITED: '请求频繁，请稍后重试。',
  ACCOUNT_EXISTS: '该账号已被注册，请换一个或直接登录。',
  REGISTRATION_CLOSED: '本服务器已关闭注册。',
  REGISTRATION_CODE_INVALID: '邀请码不正确。',
  WEAK_PASSWORD: '密码至少 12 位。',
  INVALID_ACCOUNT: '账号只能包含字母、数字、点、下划线或短横线（3–32 位）。',
  ACCOUNT_LIMIT_REACHED: '本服务器账号数量已达上限。',
  ACCOUNT_DISABLED: '该账号已被管理员停用。',
  CODE_INVALID: '验证码不正确或已过期。',
  INVALID_EMAIL: '请输入有效的邮箱地址。',
  EMAIL_IN_USE: '该邮箱已被其他账号绑定。',
  SMTP_NOT_CONFIGURED: '管理员尚未配置邮件服务器。',
  SMTP_FAILED: '邮件服务器连接失败，请检查配置。',
  ADMIN_REQUIRED: '需要管理员权限。',
  SELF_FORBIDDEN: '不能对当前登录的账号执行该操作。',
  ACCOUNT_NOT_FOUND: '账号不存在。',
}
export async function api<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'PUT' | 'DELETE'): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    })
  } catch { throw new RequestError('连接失败，请重试。', 0) }
  let data: any
  try { data = await response.json() } catch { throw new RequestError('服务响应异常，请重试。', response.status) }
  if (!response.ok) throw new RequestError(MESSAGES[data?.error?.code] ?? data?.error?.message ?? '请求失败，请稍后重试。', response.status)
  return data as T
}
