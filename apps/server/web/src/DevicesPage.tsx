// Simplified upstream HostsPage + product AppHeader. No remote/open/admin actions.
import { Alert, Button, Card, Divider, Empty, Form, Input, Layout, Modal, Space, Table, Tag, Typography } from 'antd'
import { EditOutlined, GithubOutlined, SettingOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, RequestError, type Account, type Device, type DeviceList } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'
const { Paragraph, Text, Title } = Typography
export function DevicesPage({ account, onSignedOut, onOpenAdmin }: { account: Account; onSignedOut: () => void; onOpenAdmin: () => void }) {
  const [result, setResult] = useState<DeviceList>()
  const [loading, setLoading] = useState(true)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [updated, setUpdated] = useState('')
  const [renaming, setRenaming] = useState<Device>()
  const [newName, setNewName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profile, setProfile] = useState<Account>(account)
  const [emailForm] = Form.useForm<{ email: string; code: string }>()
  const [passwordForm] = Form.useForm<{ currentPassword: string; password: string }>()
  const [emailBusy, setEmailBusy] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsNotice, setSettingsNotice] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const data = await api<DeviceList>('/account/devices'); setResult(data); setUpdated(new Date().toLocaleTimeString('zh-CN')) }
    catch (err) { if (err instanceof RequestError && err.status === 401) onSignedOut(); else setError(err instanceof Error ? err.message : '加载失败，请重试。') }
    finally { setLoading(false) }
  }, [onSignedOut])
  useEffect(() => { void load() }, [load])
  async function refreshProfile() {
    try { setProfile(await api<Account>('/auth/me')) } catch { /* keep the previous profile */ }
  }
  async function submitRename() {
    if (!renaming) return
    const name = newName.trim()
    if (!name) { setError('设备名称不能为空'); return }
    setSavingName(true); setError('')
    try { await api(`/devices/${encodeURIComponent(renaming.deviceId)}/name`, { name }); setRenaming(undefined); await load() }
    catch (err) { setError(err instanceof Error ? err.message : '改名失败，请重试。') }
    finally { setSavingName(false) }
  }
  async function sendEmailCode() {
    setEmailBusy(true); setSettingsError(''); setSettingsNotice('')
    try {
      const values = await emailForm.validateFields(['email'])
      await api('/auth/email/code', { email: values.email.trim() })
      setSettingsNotice('验证码已发送到该邮箱，10 分钟内有效。')
    } catch (err) { setSettingsError(err instanceof Error ? err.message : '发送失败，请重试。') }
    finally { setEmailBusy(false) }
  }
  async function bindEmail() {
    setEmailBusy(true); setSettingsError(''); setSettingsNotice('')
    try {
      const values = await emailForm.validateFields()
      setProfile(await api<Account>('/auth/email/bind', { email: values.email.trim(), code: values.code.trim() }))
      emailForm.resetFields()
      setSettingsNotice('邮箱绑定成功，之后可用它找回密码。')
    } catch (err) { setSettingsError(err instanceof Error ? err.message : '绑定失败，请重试。') }
    finally { setEmailBusy(false) }
  }
  async function changePassword() {
    setPasswordBusy(true); setSettingsError(''); setSettingsNotice('')
    try {
      const values = await passwordForm.validateFields()
      await api('/auth/password', { currentPassword: values.currentPassword, password: values.password })
      passwordForm.resetFields()
      setSettingsNotice('密码已更新。')
    } catch (err) { setSettingsError(err instanceof Error ? err.message : '修改失败，请重试。') }
    finally { setPasswordBusy(false) }
  }
  function openSettings() {
    setSettingsOpen(true); setSettingsError(''); setSettingsNotice('')
    emailForm.setFieldsValue({ email: profile.email ?? '', code: '' })
    void refreshProfile()
  }
  async function logout() {
    setLoggingOut(true)
    try { await api('/auth/logout', {}); onSignedOut() }
    catch (err) { setError(err instanceof Error ? err.message : '退出失败，请重试。') }
    finally { setLoggingOut(false) }
  }
  const devices = [...(result?.items ?? [])].sort((a, b) => Number(b.online) - Number(a.online))
  const columns: TableColumnsType<Device> = [
    {
      title: '设备名称', dataIndex: 'name', key: 'name', render: (name: string, d) => renaming?.deviceId === d.deviceId
        ? <Space size={6}>
            <Input size="small" value={newName} autoFocus maxLength={80} style={{ width: 200 }} onChange={event => setNewName(event.target.value)} onPressEnter={() => void submitRename()} onKeyDown={event => { if (event.key === 'Escape') setRenaming(undefined) }} />
            <Button size="small" type="primary" loading={savingName} onClick={() => void submitRename()}>保存</Button>
            <Button size="small" onClick={() => setRenaming(undefined)}>取消</Button>
          </Space>
        : <Space size={10}><span className={`host-status-dot ${d.online ? 'is-online' : ''}`} /><Text strong className="selfhost-device-name">{name}</Text><Button type="text" size="small" icon={<EditOutlined />} aria-label="修改设备名称" onClick={() => { setRenaming(d); setNewName(d.name) }} /></Space>,
    },
    { title: '状态', dataIndex: 'online', key: 'online', render: (online: boolean) => online ? <Tag color="green">在线</Tag> : <Tag>离线</Tag> },
    { title: '角色', dataIndex: 'role', key: 'role', render: (role: string) => role === 'host' ? 'Host' : '客户端' },
    { title: '系统', dataIndex: 'platform', key: 'platform', render: (platform: string) => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' })[platform] ?? platform },
    { title: '插件版本', dataIndex: 'clientVersion', key: 'clientVersion' },
    { title: 'Harness 版本', dataIndex: 'harnessVersion', key: 'harnessVersion', render: (value?: string) => value || '—' },
  ]
  return <>
    <Layout.Header className="topbar product-topbar"><div className="topbar-inner"><div className="topbar-brand-group is-product"><a className="topbar-brand" href="/" aria-label="返回首页"><img className="topbar-brand-mark" src="/brand-whale.webp" alt="" width="40" height="40" /><span className="topbar-brand-copy"><Title level={3}>DeepSeek Harness Remote</Title><small>安全远程访问</small></span></a></div><div className="topbar-actions"><a className="topbar-github-link product-github-link" href="https://github.com/liguobao/ds-harness-remote" target="_blank" rel="noreferrer" aria-label="GitHub"><GithubOutlined /> GitHub</a><ThemeToggle />{profile.isAdmin === true && <Button type="text" onClick={onOpenAdmin}>控制台</Button>}<Button type="text" icon={<SettingOutlined />} onClick={openSettings}>账号设置</Button><Button type="text" loading={loggingOut} onClick={() => void logout()}>退出登录</Button></div></div></Layout.Header>
    <Layout.Content className="product-content selfhost-content" id="main-content">
      <div className="app-area"><div className="workspace-view"><div className="hosts-page">
        <header className="workspace-page-header"><div><Title level={2}>我的设备</Title><Paragraph className="selfhost-account">{account.account}{profile.isAdmin === true ? '（管理员）' : ''}{profile.email ? ` · ${profile.email}` : ''}</Paragraph></div><Space className="workspace-page-actions" wrap><Button onClick={() => void load()} loading={loading}>刷新</Button></Space></header>
        {error && <Alert className="selfhost-error" type="error" showIcon message={error} />}
        {notice && <Alert className="selfhost-error" type="success" showIcon message={notice} />}
        <Card className="page-card selfhost-connection" title="服务地址"><Paragraph><Text code className="selfhost-address">{result?.serverUrl ?? '加载中…'}</Text></Paragraph><Paragraph>Host 和客户端使用此地址，且必须登录同一账号。</Paragraph></Card>
        <Card className="page-card hosts-list-card" title="设备状态" extra={result ? <Text type="secondary">{devices.filter(d => d.online).length} / {devices.length} 台在线</Text> : undefined}>
          {!error && !loading && !devices.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无设备" /> : <Table<Device> rowKey="deviceId" columns={columns} dataSource={devices} loading={loading} pagination={false} scroll={{ x: 'max-content' }} />}
        </Card>
        {updated && <Paragraph className="selfhost-caption" type="secondary">更新于 {updated}</Paragraph>}
      </div></div></div>
    </Layout.Content><SiteFooter />
    <Modal title="账号设置" open={settingsOpen} onCancel={() => setSettingsOpen(false)} footer={null} width={520}>
      {settingsError && <Alert type="error" showIcon message={settingsError} style={{ marginBottom: 16 }} />}
      {settingsNotice && <Alert type="success" showIcon message={settingsNotice} style={{ marginBottom: 16 }} />}
      <Paragraph><Text type="secondary">账号：</Text><Text strong>{profile.account}</Text>{profile.isAdmin === true && <Tag color="blue" style={{ marginLeft: 8 }}>管理员</Tag>}</Paragraph>
      <Paragraph><Text type="secondary">绑定邮箱：</Text>{profile.email ? <>{profile.email} <Tag color="green">已验证</Tag></> : <Text type="secondary">未绑定</Text>}</Paragraph>
      <Divider orientation="left" plain>绑定 / 更换邮箱</Divider>
      <Form form={emailForm} layout="vertical" requiredMark={false}>
        <Form.Item name="email" label="邮箱地址" rules={[{ required: true, whitespace: true, message: '请输入邮箱' }]}><Input placeholder="you@example.com" autoComplete="email" /></Form.Item>
        <Space align="end">
          <Form.Item name="code" label="验证码" rules={[{ required: true, message: '请输入验证码' }]}><Input placeholder="6 位验证码" maxLength={6} /></Form.Item>
          <Form.Item style={{ marginBottom: 24 }}><Button loading={emailBusy} onClick={() => void sendEmailCode()}>发送验证码</Button></Form.Item>
          <Form.Item style={{ marginBottom: 24 }}><Button type="primary" loading={emailBusy} onClick={() => void bindEmail()}>绑定</Button></Form.Item>
        </Space>
      </Form>
      <Divider orientation="left" plain>修改密码</Divider>
      <Form form={passwordForm} layout="vertical" requiredMark={false}>
        <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}><Input.Password autoComplete="current-password" /></Form.Item>
        <Form.Item name="password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 12, message: '密码至少 12 位' }]}><Input.Password placeholder="至少 12 位" autoComplete="new-password" /></Form.Item>
        <Button type="primary" loading={passwordBusy} onClick={() => void changePassword()}>更新密码</Button>
      </Form>
    </Modal>
  </>
}
