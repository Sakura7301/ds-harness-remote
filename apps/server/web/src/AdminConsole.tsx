import { Alert, Button, Card, Form, Input, InputNumber, Layout, Modal, Space, Statistic, Switch, Table, Tabs, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, GithubOutlined, ReloadOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, type Account, type AdminAccount, type AdminOverview, type SiteInfo, type SiteSettings, type SmtpSettings } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'
const { Paragraph, Text, Title } = Typography
const MASK = '********'

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${minutes} 分钟`
}

/** Administrator console: service overview, site profile, SMTP and accounts. */
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
    try {
      await api('/admin/smtp/test', {})
      setNotice('邮件服务器连接成功。')
    } catch (err) { fail(err, '邮件服务器连接失败。') } finally { setBusy(false) }
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
        try {
          await api(`/admin/accounts/${encodeURIComponent(name)}`, undefined, 'DELETE')
          setNotice(`已删除 ${name}`); await load()
        } catch (err) { fail(err, '删除失败。') }
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
  const overviewTab = <div className="admin-overview">
    {!overview ? <Paragraph>加载中…</Paragraph> : <>
      <div className="admin-stat-grid">
        <Card><Statistic title="账号" value={overview.accounts} suffix={`/ ${overview.admins} 管理员`} /></Card>
        <Card><Statistic title="设备" value={overview.devices} suffix={`${overview.onlineDevices} 在线`} /></Card>
        <Card><Statistic title="Host / 客户端" value={overview.hosts} suffix={`/ ${overview.clients}`} /></Card>
        <Card><Statistic title="运行时长" value={formatDuration(overview.uptimeMs)} /></Card>
      </div>
      <Card className="page-card" title="服务信息">
        <Paragraph><Text type="secondary">服务地址：</Text><Text code>{overview.serverUrl}</Text></Paragraph>
        <Paragraph><Text type="secondary">版本：</Text>{overview.version}</Paragraph>
        <Paragraph><Text type="secondary">启动时间：</Text>{new Date(overview.startedAt).toLocaleString('zh-CN')}</Paragraph>
        <Paragraph><Text type="secondary">邮件服务器：</Text>{overview.smtpConfigured ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>}</Paragraph>
        <Paragraph><Text type="secondary">注册：</Text>{overview.registration.enabled ? (overview.registration.requiresCode ? <Tag color="green">开启（需邀请码）</Tag> : <Tag color="green">开启</Tag>) : <Tag>关闭</Tag>}</Paragraph>
      </Card>
    </>}
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
  const smtpTab = <Card className="page-card" title="邮件服务器" extra={<Text type="secondary">用于邮箱验证与找回密码</Text>}>
    <Form form={smtpForm} layout="vertical" requiredMark={false}>
      <Form.Item name="enabled" label="启用邮件服务" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="host" label="SMTP 服务器"><Input placeholder="smtp.example.com" /></Form.Item>
      <Form.Item name="port" label="端口"><InputNumber min={1} max={65535} style={{ width: 200 }} placeholder="465 / 587" /></Form.Item>
      <Form.Item name="secure" label="使用 SSL/TLS（465 端口通常开启）" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="user" label="用户名"><Input autoComplete="off" /></Form.Item>
      <Form.Item name="pass" label="密码 / 授权码" extra="已保存的密码显示为 ********，不修改则保持不变"><Input.Password autoComplete="new-password" /></Form.Item>
      <Form.Item name="from" label="发件人"><Input placeholder="DSH Remote <no-reply@example.com>" /></Form.Item>
      <Space><Button type="primary" loading={busy} onClick={() => void saveSmtp()}>保存</Button><Button loading={busy} onClick={() => void testSmtp()}>测试连接</Button></Space>
    </Form>
  </Card>
  const accountsTab = <Card className="page-card" title="用户管理" extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>}>
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
