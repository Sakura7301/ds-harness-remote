import { Alert, Button, Card, Form, Input, InputNumber, Layout, Modal, Progress, Space, Switch, Table, Tabs, Tag, Typography } from 'antd'
import { ArrowDownOutlined, ArrowLeftOutlined, ArrowUpOutlined, GithubOutlined, HddOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, type Account, type AdminAccount, type AdminOverview, type NetworkPoint, type SiteInfo, type SiteSettings, type SmtpSettings } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'
const { Paragraph, Text, Title } = Typography
const MASK = '********'

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟`
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Small inline traffic chart; no chart library is pulled into the bundle. */
function TrafficChart({ history }: { history: NetworkPoint[] }) {
  if (history.length < 2) return <div className="traffic-chart-empty">正在采样…</div>
  const width = 520, height = 96, padding = 4
  const peak = Math.max(1, ...history.map(point => Math.max(point.rx, point.tx)))
  const line = (pick: (point: NetworkPoint) => number) => history.map((point, index) => {
    const x = padding + (index / (history.length - 1)) * (width - padding * 2)
    const y = height - padding - (pick(point) / peak) * (height - padding * 2)
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return <div className="traffic-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="上下行速率曲线">
      <line x1={0} y1={height - padding} x2={width} y2={height - padding} className="traffic-axis" />
      <path d={line(point => point.tx)} className="traffic-line traffic-down" />
      <path d={line(point => point.rx)} className="traffic-line traffic-up" />
    </svg>
    <div className="traffic-legend"><span className="traffic-legend-up">↑ 上行（Host → 客户端）</span><span className="traffic-legend-down">↓ 下行（客户端 → Host）</span><span className="traffic-legend-peak">峰值 {formatRate(peak)} · 最近 {history.length} 次采样</span></div>
  </div>
}

/** Administrator console: service health, traffic, site profile, SMTP and accounts. */
export function AdminConsole({ account, onBack, onSignedOut }: { account: Account; onBack: () => void; onSignedOut: () => void }) {
  const [overview, setOverview] = useState<AdminOverview>()
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [site, setSite] = useState<SiteSettings>({})
  const [siteName, setSiteName] = useState<SiteInfo>()
  const [smtp, setSmtp] = useState<SmtpSettings>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [siteForm] = Form.useForm<SiteSettings>()
  const [smtpForm] = Form.useForm<SmtpSettings>()

  const fail = (err: unknown, fallback: string) => {
    setError(err instanceof Error ? err.message : fallback)
    setNotice('')
  }
  const loadOverview = useCallback(async () => {
    try { setOverview(await api<AdminOverview>('/admin/overview')) } catch (err) { fail(err, '加载服务状态失败。') }
  }, [])
  const load = useCallback(async () => {
    setError('')
    try {
      const [nextOverview, nextAccounts, nextSite, nextSmtp] = await Promise.all([
        api<AdminOverview>('/admin/overview'),
        api<{ items: AdminAccount[] }>('/admin/accounts'),
        api<SiteInfo & { site: SiteSettings }>('/admin/site'),
        api<SmtpSettings>('/admin/smtp'),
      ])
      setOverview(nextOverview)
      setAccounts(nextAccounts.items)
      setSite(nextSite.site)
      setSiteName(nextSite)
      setSmtp(nextSmtp)
      siteForm.setFieldsValue(nextSite.site)
      smtpForm.setFieldsValue({ ...nextSmtp, pass: nextSmtp.pass === MASK ? MASK : '' })
    } catch (err) { fail(err, '加载控制台数据失败。') }
  }, [siteForm, smtpForm])
  useEffect(() => { void load() }, [load])
  // The console polls while it is open, which is also what feeds the traffic chart.
  useEffect(() => {
    const timer = window.setInterval(() => { void loadOverview() }, 5000)
    return () => window.clearInterval(timer)
  }, [loadOverview])
  async function saveSite() {
    setBusy(true); setError(''); setNotice('')
    try {
      const values = await siteForm.validateFields()
      await api('/admin/site', values, 'PUT')
      setNotice('站点信息已保存。'); await load()
    } catch (err) { fail(err, '保存失败。') } finally { setBusy(false) }
  }
  async function saveSmtp() {
    setBusy(true); setError(''); setNotice('')
    try {
      const values = await smtpForm.validateFields()
      await api('/admin/smtp', values, 'PUT')
      setNotice('邮件服务器配置已保存。'); await load()
    } catch (err) { fail(err, '保存失败。') } finally { setBusy(false) }
  }
  async function testSmtp() {
    setBusy(true); setError(''); setNotice('')
    try { await api('/admin/smtp/test', {}); setNotice('邮件服务器连接成功。') }
    catch (err) { fail(err, '邮件服务器连接失败。') } finally { setBusy(false) }
  }
  async function toggleAccount(name: string, disabled: boolean) {
    setError(''); setNotice('')
    try {
      await api(`/admin/accounts/${encodeURIComponent(name)}/disabled`, { disabled })
      setNotice(disabled ? `已停用 ${name}` : `已启用 ${name}`)
      await load()
    } catch (err) { fail(err, '操作失败。') }
  }
  function removeAccount(name: string) {
    Modal.confirm({
      title: `删除账号 ${name}？`,
      content: '该账号的设备与登录状态会一并清除，此操作不可撤销。',
      okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try { await api(`/admin/accounts/${encodeURIComponent(name)}`, undefined, 'DELETE'); setNotice(`已删除 ${name}`); await load() }
        catch (err) { fail(err, '删除失败。') }
      },
    })
  }
  async function signOut() {
    try { await api('/auth/logout', {}) } catch { /* ignore */ }
    onSignedOut()
  }
  const columns: TableColumnsType<AdminAccount> = [
    { title: '账号', dataIndex: 'account', key: 'account', render: (name: string, row) => <Space size={8}><Text strong>{name}</Text>{row.role === 'admin' && <Tag color="blue">管理员</Tag>}{row.disabled && <Tag color="red">已停用</Tag>}</Space> },
    { title: '邮箱', dataIndex: 'email', key: 'email', render: (email?: string) => email || '—' },
    { title: '设备', dataIndex: 'devices', key: 'devices' },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: (value: number) => new Date(value).toLocaleString('zh-CN') },
    {
      title: '操作', key: 'actions',
      render: (_: unknown, row) => <Space>
        <Button size="small" disabled={row.account === account.account} onClick={() => void toggleAccount(row.account, !row.disabled)}>{row.disabled ? '启用' : '停用'}</Button>
        <Button size="small" danger disabled={row.account === account.account} onClick={() => removeAccount(row.account)}>删除</Button>
      </Space>,
    },
  ]

  const o = overview
  const overviewTab = !o ? <Paragraph>加载中…</Paragraph> : <div className="admin-overview">
    <div className="admin-section-grid">
      <Card className="admin-stat-card">
        <div className="admin-stat-label">服务运行</div>
        <div className="admin-stat-value">{formatDuration(o.uptimeMs / 1000)}</div>
        <div className="admin-stat-note">启动于 {new Date(o.startedAt).toLocaleString('zh-CN')}</div>
      </Card>
      <Card className="admin-stat-card">
        <div className="admin-stat-label">在线连接</div>
        <div className="admin-stat-value">{o.network.peers}</div>
        <div className="admin-stat-note">已认证的 WebSocket 连接</div>
      </Card>
      <Card className="admin-stat-card">
        <div className="admin-stat-label">Host</div>
        <div className="admin-stat-value">{o.devices.hostsOnline}<span className="admin-stat-total"> / {o.devices.hosts}</span></div>
        <div className="admin-stat-note">在线 / 已注册</div>
      </Card>
      <Card className="admin-stat-card">
        <div className="admin-stat-label">客户端</div>
        <div className="admin-stat-value">{o.devices.clientsOnline}<span className="admin-stat-total"> / {o.devices.clients}</span></div>
        <div className="admin-stat-note">在线 / 已注册</div>
      </Card>
      <Card className="admin-stat-card">
        <div className="admin-stat-label">账号</div>
        <div className="admin-stat-value">{o.accounts.users}</div>
        <div className="admin-stat-note">{o.accounts.admins} 位管理员 · 共 {o.accounts.total} 个账号</div>
      </Card>
    </div>

    <Card className="page-card" title={<Space><ThunderboltOutlined />实时流量</Space>} extra={<Text type="secondary">每 5 秒采样</Text>}>
      <div className="traffic-summary">
        <div><span className="traffic-key traffic-key-up">↑ 上行</span><span className="traffic-value">{formatRate(o.network.txRate)}</span><span className="traffic-total">累计 {formatBytes(o.network.txBytes)}</span></div>
        <div><span className="traffic-key traffic-key-down">↓ 下行</span><span className="traffic-value">{formatRate(o.network.rxRate)}</span><span className="traffic-total">累计 {formatBytes(o.network.rxBytes)}</span></div>
      </div>
      <TrafficChart history={o.network.history} />
    </Card>

    <div className="admin-section-grid">
      <Card className="page-card admin-resource-card" title={<Space><HddOutlined />资源占用</Space>}>
        <div className="resource-row"><span>CPU（{o.system.cpuCount} 核）</span><Progress percent={o.system.cpuUsage} size="small" status={o.system.cpuUsage >= 85 ? 'exception' : 'normal'} /></div>
        <div className="resource-row"><span>内存 {formatBytes(o.system.memory.total - o.system.memory.free)} / {formatBytes(o.system.memory.total)}</span><Progress percent={o.system.memory.usedPercent} size="small" status={o.system.memory.usedPercent >= 90 ? 'exception' : 'normal'} /></div>
        <div className="resource-row"><span>磁盘 {formatBytes(o.system.disk.total - o.system.disk.free)} / {formatBytes(o.system.disk.total)}</span><Progress percent={o.system.disk.usedPercent} size="small" status={o.system.disk.usedPercent >= 90 ? 'exception' : 'normal'} /></div>
        <Paragraph className="admin-resource-note" type="secondary">负载 {o.system.load.join(' / ')} · 宿主运行 {formatDuration(o.system.hostUptimeSeconds)} · {o.system.platform}/{o.system.arch} · Node {o.system.nodeVersion}</Paragraph>
      </Card>
      <Card className="page-card admin-resource-card" title="服务信息">
        <Paragraph><Text type="secondary">服务地址：</Text><Text code copyable>{o.serverUrl}</Text></Paragraph>
        <Paragraph><Text type="secondary">版本：</Text>{o.version}</Paragraph>
        <Paragraph><Text type="secondary">邮件服务器：</Text>{o.email.enabled ? <Tag color="green">已配置（{o.email.source === 'env' ? '环境变量' : '控制台'}）</Tag> : <Tag color="orange">未配置</Tag>}</Paragraph>
        <Paragraph><Text type="secondary">注册：</Text>{o.registration.enabled ? (o.registration.requiresCode ? <Tag color="green">开启（需邀请码）</Tag> : <Tag color="green">开启</Tag>) : <Tag>关闭</Tag>}{o.email.verificationRequired && <Tag color="blue">注册需邮箱验证</Tag>}</Paragraph>
      </Card>
    </div>
  </div>

  const siteTab = <Card className="page-card" title="站点信息" extra={<Text type="secondary">首页与登录页展示的内容</Text>}>
    <Form form={siteForm} layout="vertical" requiredMark={false}>
      <Form.Item name="name" label="站点名称"><Input placeholder="DeepSeek Harness Remote" maxLength={120} /></Form.Item>
      <Form.Item name="description" label="站点简介"><Input.TextArea rows={2} maxLength={500} showCount /></Form.Item>
      <Form.Item name="announcement" label="公告（首页横幅）"><Input.TextArea rows={3} maxLength={2000} showCount placeholder="留空则不显示公告" /></Form.Item>
      <Form.Item name="footer" label="页脚文字"><Input maxLength={500} placeholder="例如 © 2026 我的中转站" /></Form.Item>
      <Space><Button type="primary" loading={busy} onClick={() => void saveSite()}>保存站点信息</Button><Button onClick={() => { siteForm.setFieldsValue(site) }}>重置</Button></Space>
    </Form>
  </Card>

  const smtpTab = <Card className="page-card" title="邮件服务器" extra={<Text type="secondary">用于注册邮箱验证、账号绑定邮箱与找回密码</Text>}>
    {smtp.source === 'env' && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="当前配置来自环境变量（DSH_SERVER_SMTP_*），在这里保存后会以控制台配置为准。" />}
    {smtp.source === 'none' && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="尚未配置邮件服务器。未配置时不支持邮箱绑定与找回密码，注册也不需要邮箱验证。" />}
    <Form form={smtpForm} layout="vertical" requiredMark={false}>
      <Form.Item name="enabled" label="启用邮件服务（需同时填写服务器、端口与发件人）" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="host" label="SMTP 服务器"><Input placeholder="smtp.qq.com" /></Form.Item>
      <Form.Item name="port" label="端口"><InputNumber min={1} max={65535} style={{ width: 200 }} placeholder="465 / 587" /></Form.Item>
      <Form.Item name="secure" label="使用 SSL/TLS（465 端口通常开启）" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="user" label="SMTP 用户名"><Input autoComplete="off" placeholder="一般与发件邮箱相同" /></Form.Item>
      <Form.Item name="pass" label="SMTP 密码 / 授权码" extra="这是邮箱服务商（QQ 邮箱、Gmail 等）给出的 SMTP 授权码，用来登录 SMTP 服务器发信；不是本站发给用户的验证码。已保存时显示 ********，不修改则保持不变。"><Input.Password autoComplete="new-password" /></Form.Item>
      <Form.Item name="from" label="发件人"><Input placeholder="DSH Remote <no-reply@example.com>" /></Form.Item>
      <Space><Button type="primary" loading={busy} onClick={() => void saveSmtp()}>保存</Button><Button loading={busy} onClick={() => void testSmtp()}>测试连接</Button></Space>
    </Form>
  </Card>

  const accountsTab = <Card className="page-card" title="用户管理" extra={<Text type="secondary">共 {accounts.length} 个账号</Text>}>
    <Table<AdminAccount> rowKey="account" columns={columns} dataSource={accounts} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 'max-content' }} />
  </Card>
  return <>
    <Layout.Header className="topbar product-topbar"><div className="topbar-inner">
      <div className="topbar-brand-group is-product"><a className="topbar-brand" href="/" aria-label="返回首页"><img className="topbar-brand-mark" src="/brand-whale.webp" alt="" width="40" height="40" /><span className="topbar-brand-copy"><Title level={3}>控制台</Title><small>{siteName?.name ?? 'DeepSeek Harness Remote'}</small></span></a></div>
      <div className="topbar-actions"><a className="topbar-github-link product-github-link" href="https://github.com/liguobao/ds-harness-remote" target="_blank" rel="noreferrer" aria-label="GitHub"><GithubOutlined /> GitHub</a><ThemeToggle /><Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>返回设备</Button><Button type="text" onClick={() => void signOut()}>退出登录</Button></div>
    </div></Layout.Header>
    <Layout.Content className="product-content selfhost-content" id="main-content">
      <div className="app-area"><div className="workspace-view"><div className="hosts-page">
        <header className="workspace-page-header"><div><Title level={2}>管理员控制台</Title><Paragraph className="selfhost-account">{account.account}</Paragraph></div></header>
        {error && <Alert className="selfhost-error" type="error" showIcon message={error} />}
        {notice && <Alert className="selfhost-error" type="success" showIcon message={notice} />}
        <Tabs items={[
          { key: 'overview', label: '概览', children: overviewTab },
          { key: 'site', label: '站点设置', children: siteTab },
          { key: 'smtp', label: '邮件服务器', children: smtpTab },
          { key: 'accounts', label: '用户管理', children: accountsTab },
        ]} />
      </div></div></div>
    </Layout.Content><SiteFooter />
  </>
}
