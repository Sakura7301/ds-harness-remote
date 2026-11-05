// Simplified upstream HostsPage + product AppHeader. No remote/open actions.
import { Alert, Button, Card, Empty, Form, Input, Layout, Modal, Space, Table, Tag, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, GithubOutlined, SettingOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, RequestError, type Account, type Device, type DeviceList, type SiteInfo } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'
const { Paragraph, Text, Title } = Typography
type SettingsSection = 'none' | 'nickname' | 'email' | 'password'
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
  const [section, setSection] = useState<SettingsSection>('none')
  const [profile, setProfile] = useState<Account>(account)
  const [site, setSite] = useState<SiteInfo>()
  const [nicknameForm] = Form.useForm<{ nickname: string }>()
  const [emailForm] = Form.useForm<{ email: string; code: string }>()
  const [passwordForm] = Form.useForm<{ code: string; currentPassword: string; password: string }>()
  const [busy, setBusy] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [settingsNotice, setSettingsNotice] = useState('')
  const [deleting, setDeleting] = useState<Device>()
  const [deleteForm] = Form.useForm<{ code: string }>()
  const [deleteError, setDeleteError] = useState('')
  const emailEnabled = site?.email.enabled === true
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const data = await api<DeviceList>('/account/devices'); setResult(data); setUpdated(new Date().toLocaleTimeString('zh-CN')) }
    catch (err) { if (err instanceof RequestError && err.status === 401) onSignedOut(); else setError(err instanceof Error ? err.message : '加载失败，请重试。') }
    finally { setLoading(false) }
  }, [onSignedOut])
  useEffect(() => { void load() }, [load])
  useEffect(() => { api<SiteInfo>('/site').then(setSite).catch(() => setSite(undefined)) }, [])
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
  function openSettings() {
    setSettingsOpen(true); setSection('none'); setSettingsError(''); setSettingsNotice('')
    nicknameForm.setFieldsValue({ nickname: profile.nickname ?? profile.account })
    emailForm.resetFields()
    passwordForm.resetFields()
    void refreshProfile()
  }
  function openSection(next: SettingsSection) {
    setSection(next); setSettingsError(''); setSettingsNotice('')
    if (next === 'nickname') nicknameForm.setFieldsValue({ nickname: profile.nickname ?? profile.account })
    if (next === 'email') emailForm.setFieldsValue({ email: profile.email ?? '', code: '' })
    if (next === 'password') passwordForm.resetFields()
  }
  async function saveNickname() {
    setBusy('nickname'); setSettingsError(''); setSettingsNotice('')
    try {
      const values = await nicknameForm.validateFields()
      setProfile(await api<Account>('/auth/profile', { nickname: values.nickname.trim() }))
      setSettingsNotice('昵称已更新。'); setSection('none')
    } catch (err) { setSettingsError(err instanceof Error ? err.message : '保存失败，请重试。') }
    finally { setBusy('') }
  }
  async function sendEmailCode() {
    setBusy('email'); setSettingsError(''); setSettingsNotice('')
    try {
      const values = await emailForm.validateFields(['email'])
      await api('/auth/email/code', { email: values.email.trim() })
      setSettingsNotice('验证码已发送到新邮箱，10 分钟内有效。')
    } catch (err) { setSettingsError(err instanceof Error ? err.message : '发送失败，请重试。') }
    finally { setBusy('') }
  }
  async function bindEmail() {
    setBusy('email'); setSettingsError(''); setSettingsNotice('')
    try {
      const values = await emailForm.validateFields()
      const next = await api<Account>('/auth/email/bind', { email: values.email.trim(), code: values.code.trim() })
      setProfile(next); setSettingsNotice('邮箱已换绑，之后用新邮箱登录。'); setSection('none')
    } catch (err) { setSettingsError(err instanceof Error ? err.message : '换绑失败，请重试。') }
    finally { setBusy('') }
  }
  async function sendPasswordCode() {
    setBusy('password-code'); setSettingsError(''); setSettingsNotice('')
    try {
      await api('/auth/password/code', {})
      setSettingsNotice('验证码已发送到当前绑定邮箱，10 分钟内有效。')
    } catch (err) { setSettingsError(err instanceof Error ? err.message : '发送失败，请重试。') }
    finally { setBusy('') }
  }
  async function changePassword() {
    setBusy('password'); setSettingsError(''); setSettingsNotice('')
    try {
      const values = await passwordForm.validateFields()
      await api('/auth/password', {
        password: values.password,
        ...(emailEnabled ? { code: values.code.trim() } : { currentPassword: values.currentPassword }),
      })
      passwordForm.resetFields()
      setSettingsNotice('密码已更新。'); setSection('none')
    } catch (err) { setSettingsError(err instanceof Error ? err.message : '修改失败，请重试。') }
    finally { setBusy('') }
  }
  async function sendDeleteCode(device: Device) {
    setBusy('delete-code'); setDeleteError('')
    try {
      await api(`/account/devices/${encodeURIComponent(device.deviceId)}/delete/code`, {})
      setNotice('验证码已发送到绑定邮箱，10 分钟内有效。')
    } catch (err) { setDeleteError(err instanceof Error ? err.message : '发送失败，请重试。') }
    finally { setBusy('') }
  }
  async function confirmDelete() {
    if (!deleting) return
    setBusy('delete'); setDeleteError('')
    try {
      const values = await deleteForm.validateFields()
      await api(`/account/devices/${encodeURIComponent(deleting.deviceId)}`, { code: values.code.trim() }, 'DELETE')
      setDeleting(undefined); deleteForm.resetFields()
      setNotice('设备已删除。'); await load()
    } catch (err) { setDeleteError(err instanceof Error ? err.message : '删除失败，请重试。') }
    finally { setBusy('') }
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
    {
      title: '操作', key: 'actions', width: 90,
      render: (_: unknown, d) => <Button size="small" danger icon={<DeleteOutlined />} onClick={() => { setDeleting(d); setDeleteError(''); deleteForm.resetFields() }}>删除</Button>,
    },
  ]
  return <>
    <Layout.Header className="topbar product-topbar"><div className="topbar-inner"><div className="topbar-brand-group is-product"><a className="topbar-brand" href="/" aria-label="返回首页"><img className="topbar-brand-mark" src="/brand-whale.webp" alt="" width="40" height="40" /><span className="topbar-brand-copy"><Title level={3}>DeepSeek Harness Remote</Title><small>安全远程访问</small></span></a></div><div className="topbar-actions"><a className="topbar-github-link product-github-link" href="https://github.com/liguobao/ds-harness-remote" target="_blank" rel="noreferrer" aria-label="GitHub"><GithubOutlined /> GitHub</a><ThemeToggle />{profile.isAdmin === true && <Button type="text" onClick={onOpenAdmin}>控制台</Button>}<Button type="text" icon={<SettingOutlined />} onClick={openSettings}>账号设置</Button><Button type="text" loading={loggingOut} onClick={() => void logout()}>退出登录</Button></div></div></Layout.Header>
    <Layout.Content className="product-content selfhost-content" id="main-content">
      <div className="app-area"><div className="workspace-view"><div className="hosts-page">
        <header className="workspace-page-header"><div><Title level={2}>{profile.nickname ?? profile.account}</Title><Paragraph className="selfhost-account">{profile.account}{profile.isAdmin === true ? '（管理员）' : ''}</Paragraph></div><Space className="workspace-page-actions" wrap><Button onClick={() => void load()} loading={loading}>刷新</Button></Space></header>
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
      <div className="account-summary">
        <div className="account-summary-row"><span>昵称</span><Text strong>{profile.nickname ?? profile.account}</Text></div>
        <div className="account-summary-row"><span>邮箱</span><Text strong>{profile.email ?? profile.account}</Text>{profile.isAdmin === true && <Tag color="blue">管理员</Tag>}</div>
      </div>
      {section === 'none' && <div className="account-actions">
        <button type="button" className="account-action" onClick={() => openSection('nickname')}><span><Text strong>修改昵称</Text><br /><Text type="secondary">只影响显示，不改变登录方式</Text></span><span className="account-action-arrow">›</span></button>
        <button type="button" className="account-action" onClick={() => openSection('email')}><span><Text strong>换绑邮箱</Text><br /><Text type="secondary">邮箱就是登录账号，换绑后请用新邮箱登录</Text></span><span className="account-action-arrow">›</span></button>
        <button type="button" className="account-action" onClick={() => openSection('password')}><span><Text strong>修改密码</Text><br /><Text type="secondary">{emailEnabled ? '需要邮箱验证码验证' : '需要当前密码验证'}</Text></span><span className="account-action-arrow">›</span></button>
      </div>}
      {section === 'nickname' && <>
        <Form form={nicknameForm} layout="vertical" requiredMark={false}>
          <Form.Item name="nickname" label="新昵称" rules={[{ required: true, whitespace: true, message: '请输入昵称' }, { max: 64, message: '昵称不能超过 64 个字符' }]}><Input size="large" maxLength={64} /></Form.Item>
        </Form>
        <div className="auth-modal-actions"><Button onClick={() => setSection('none')}>返回</Button><Button type="primary" loading={busy === 'nickname'} onClick={() => void saveNickname()}>保存</Button></div>
      </>}
      {section === 'email' && <>
        {!emailEnabled && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="管理员尚未配置邮件服务器，暂时无法换绑邮箱。" />}
        <Form form={emailForm} layout="vertical" requiredMark={false} disabled={!emailEnabled}>
          <Form.Item name="email" label="新邮箱" rules={[{ required: true, whitespace: true, message: '请输入新邮箱' }, { type: 'email', message: '请输入有效的邮箱地址' }]}><Input size="large" placeholder="new@example.com" autoComplete="email" /></Form.Item>
          <Form.Item label="验证码" required><Space.Compact style={{ width: '100%' }}><Form.Item name="code" noStyle rules={[{ required: true, message: '请输入验证码' }]}><Input size="large" placeholder="6 位验证码" maxLength={6} /></Form.Item><Button size="large" loading={busy === 'email'} onClick={() => void sendEmailCode()}>发送验证码</Button></Space.Compact></Form.Item>
        </Form>
        <div className="auth-modal-actions"><Button onClick={() => setSection('none')}>返回</Button><Button type="primary" loading={busy === 'email'} disabled={!emailEnabled} onClick={() => void bindEmail()}>确认换绑</Button></div>
      </>}
      {section === 'password' && <>
        <Form form={passwordForm} layout="vertical" requiredMark={false}>
          {emailEnabled
            ? <Form.Item label="邮箱验证码" required><Space.Compact style={{ width: '100%' }}><Form.Item name="code" noStyle rules={[{ required: true, message: '请输入验证码' }]}><Input size="large" placeholder="6 位验证码" maxLength={6} /></Form.Item><Button size="large" loading={busy === 'password-code'} onClick={() => void sendPasswordCode()}>发送验证码</Button></Space.Compact><div className="account-hint">验证码发到当前绑定邮箱 {profile.email ?? profile.account}</div></Form.Item>
            : <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}><Input.Password size="large" autoComplete="current-password" /></Form.Item>}
          <Form.Item name="password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 12, message: '密码至少 12 位' }]}><Input.Password size="large" placeholder="至少 12 位" autoComplete="new-password" /></Form.Item>
        </Form>
        <div className="auth-modal-actions"><Button onClick={() => setSection('none')}>返回</Button><Button type="primary" loading={busy === 'password'} onClick={() => void changePassword()}>更新密码</Button></div>
      </>}
    </Modal>
    <Modal title={deleting ? `删除设备「${deleting.name}」` : '删除设备'} open={deleting !== undefined} onCancel={() => setDeleting(undefined)} footer={null} width={460}>
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="删除后该设备需要重新登录并配对才能再次使用。" />
      {!emailEnabled && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="管理员尚未配置邮件服务器，暂时无法通过邮箱验证删除设备。" />}
      {deleteError && <Alert type="error" showIcon message={deleteError} style={{ marginBottom: 16 }} />}
      <Form form={deleteForm} layout="vertical" requiredMark={false} disabled={!emailEnabled}>
        <Form.Item label="邮箱验证码" required><Space.Compact style={{ width: '100%' }}><Form.Item name="code" noStyle rules={[{ required: true, message: '请输入验证码' }]}><Input size="large" placeholder="6 位验证码" maxLength={6} /></Form.Item><Button size="large" loading={busy === 'delete-code'} onClick={() => { if (deleting) void sendDeleteCode(deleting) }}>发送验证码</Button></Space.Compact><div className="account-hint">验证码发到绑定邮箱 {profile.email ?? profile.account}</div></Form.Item>
      </Form>
      <div className="auth-modal-actions"><Button onClick={() => setDeleting(undefined)}>取消</Button><Button danger type="primary" loading={busy === 'delete'} disabled={!emailEnabled} onClick={() => void confirmDelete()}>确认删除</Button></div>
    </Modal>
  </>
}
