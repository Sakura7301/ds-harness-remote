// Password-only subset of upstream components/LoginPanel.tsx; keep its layout/classes.
// The self-hosted Server identifies accounts by email; a nickname is display-only.
import { Alert, Button, Card, Form, Input, Modal, Space, Typography } from 'antd'
import { GithubOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import { api, type Account, type SiteInfo } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'
const PASSWORD_MIN_LENGTH = 12
const EMAIL_RULES = [{ required: true, whitespace: true, message: '请输入邮箱' }, { type: 'email' as const, message: '请输入有效的邮箱地址' }]
export function LoginPanel({ onAuthSuccess, initialError }: { onAuthSuccess: (account: Account) => void; initialError?: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError ?? '')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [site, setSite] = useState<SiteInfo>()
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeNotice, setCodeNotice] = useState('')
  const [loginMode, setLoginMode] = useState<'password' | 'code'>('password')
  const [forgotOpen, setForgotOpen] = useState(false)
  const [forgotPhase, setForgotPhase] = useState<'request' | 'reset'>('request')
  const [forgotBusy, setForgotBusy] = useState(false)
  const [forgotError, setForgotError] = useState('')
  const [forgotNotice, setForgotNotice] = useState('')
  const [forgotForm] = Form.useForm<{ email: string; code: string; password: string }>()
  const [form] = Form.useForm<{ email: string; nickname: string; code: string; password: string; inviteCode: string }>()
  useEffect(() => {
    let cancelled = false
    api<SiteInfo>('/site')
      .then(info => { if (!cancelled) setSite(info) })
      .catch(() => { if (!cancelled) setSite(undefined) })
    return () => { cancelled = true }
  }, [])
  const registrationOpen = site?.registration.enabled === true
  const emailEnabled = site?.email.enabled === true
  const emailRequired = site?.email.verificationRequired === true
  const emailCodeLogin = site?.login.emailCode ?? 'off'
  useEffect(() => { if (emailCodeLogin === 'required') setLoginMode('code') }, [emailCodeLogin])
  function switchMode(next: 'login' | 'register') {
    setMode(next); setError(''); setCodeNotice(''); form.resetFields(['password', 'code'])
  }
  async function submit(values: { email: string; nickname: string; code: string; password: string; inviteCode: string }) {
    setLoading(true); setError('')
    try {
      const result = mode === 'register'
        ? await api<Account>('/auth/register', {
            email: values.email.trim(),
            ...(values.nickname?.trim() ? { nickname: values.nickname.trim() } : {}),
            ...(emailRequired ? { code: values.code.trim() } : {}),
            password: values.password,
            ...(values.inviteCode?.trim() ? { inviteCode: values.inviteCode.trim() } : {}),
          })
        : loginMode === 'code'
          ? await api<Account>('/auth/login', { email: values.email.trim(), code: values.code.trim() })
          : await api<Account>('/auth/login', { email: values.email.trim(), password: values.password })
      form.resetFields(['password']); onAuthSuccess(result)
    } catch (err) { setError(err instanceof Error ? err.message : (mode === 'register' ? '注册失败，请重试。' : '登录失败，请重试。')) }
    finally { setLoading(false) }
  }
  async function sendLoginCode() {
    setCodeBusy(true); setError(''); setCodeNotice('')
    try {
      const email = String(await form.getFieldValue('email') ?? '').trim()
      if (email === '') { setError('请先填写邮箱'); return }
      await api('/auth/login/code', { email })
      setCodeNotice('验证码已发送到该邮箱，10 分钟内有效。')
    } catch (err) { setError(err instanceof Error ? err.message : '发送失败，请重试。') }
    finally { setCodeBusy(false) }
  }
  async function sendRegisterCode() {
    setCodeBusy(true); setError(''); setCodeNotice('')
    try {
      const email = String(await form.getFieldValue('email') ?? '').trim()
      if (email === '') { setError('请先填写邮箱'); return }
      await api('/auth/register/code', { email })
      setCodeNotice('验证码已发送到该邮箱，10 分钟内有效。')
    } catch (err) { setError(err instanceof Error ? err.message : '发送失败，请重试。') }
    finally { setCodeBusy(false) }
  }
  async function requestResetCode() {
    setForgotBusy(true); setForgotError(''); setForgotNotice('')
    try {
      const values = await forgotForm.validateFields(['email'])
      await api('/auth/password/forgot', { email: values.email.trim() })
      setForgotPhase('reset')
      setForgotNotice('如果该邮箱已注册，验证码已发送，10 分钟内有效。')
    } catch (err) { setForgotError(err instanceof Error ? err.message : '发送失败，请重试。') }
    finally { setForgotBusy(false) }
  }
  async function submitReset() {
    setForgotBusy(true); setForgotError('')
    try {
      const values = await forgotForm.validateFields(['email', 'code', 'password'])
      await api('/auth/password/reset', { email: values.email.trim(), code: values.code.trim(), password: values.password })
      setForgotOpen(false); setForgotPhase('request'); forgotForm.resetFields()
      setError('密码已重置，请用新密码登录。')
      switchMode('login')
    } catch (err) { setForgotError(err instanceof Error ? err.message : '重置失败，请重试。') }
    finally { setForgotBusy(false) }
  }
  const registering = mode === 'register'
  return <><main className="auth-page">
    <div className="auth-language-menu"><a className="auth-github-link" href="https://github.com/liguobao/ds-harness-remote" target="_blank" rel="noreferrer"><GithubOutlined /> GitHub</a><ThemeToggle className="auth-theme-toggle" /></div>
    <section className="auth-content">
      <div className="auth-logo-stack"><a className="auth-home-link" href="/" aria-label="返回首页"><img className="auth-brand-icon" src="/brand-whale.webp" alt="" width="48" height="48" /><Typography.Title>{site?.name && site.name.trim() !== '' ? site.name : 'DeepSeek Harness Remote'}</Typography.Title></a></div>
      <Card className="auth-panel">
        <div className="auth-intro"><Typography.Title level={3} className="auth-title">{registering ? '注册' : '登录'}</Typography.Title></div>
        {error && <Alert className="selfhost-auth-error" type="error" showIcon message={error} />}
        {codeNotice && <Alert className="selfhost-auth-error" type="success" showIcon message={codeNotice} />}
        {registering && !emailEnabled && <Alert className="selfhost-auth-error" type="info" showIcon message="管理员尚未配置邮件服务器，注册暂不需要邮箱验证码。" />}
        {!registering && emailCodeLogin === 'required' && <Alert className="selfhost-auth-error" type="info" showIcon message="本服务器要求验证邮箱后才能登录，验证码会发送到你的注册邮箱。" />}
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false} className="auth-form">
          {registering && <Form.Item name="nickname" label="昵称（可选）" rules={[{ max: 64, message: '昵称不能超过 64 个字符' }]}><Input size="large" placeholder="显示用的名字，留空则用邮箱前缀" autoComplete="nickname" /></Form.Item>}
          <Form.Item name="email" label="邮箱" rules={EMAIL_RULES}><Input size="large" placeholder="you@example.com" autoComplete={registering ? 'email' : 'username'} /></Form.Item>
          {registering && emailRequired && <Form.Item label="邮箱验证码" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="code" noStyle rules={[{ required: true, message: '请输入验证码' }]}><Input size="large" placeholder="6 位验证码" maxLength={6} /></Form.Item>
              <Button size="large" loading={codeBusy} onClick={() => void sendRegisterCode()}>发送验证码</Button>
            </Space.Compact>
          </Form.Item>}
          {!registering && loginMode === 'code' && <Form.Item label="邮箱验证码" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="code" noStyle rules={[{ required: true, message: '请输入验证码' }]}><Input size="large" placeholder="6 位验证码" maxLength={6} /></Form.Item>
              <Button size="large" loading={codeBusy} onClick={() => void sendLoginCode()}>发送验证码</Button>
            </Space.Compact>
          </Form.Item>}
          {(registering || loginMode === 'password') && <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { max: 1024, message: '密码不能超过 1024 个字符' }, ...(registering ? [{ min: PASSWORD_MIN_LENGTH, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` }] : [])]}><Input.Password size="large" placeholder={registering ? `请设置密码（至少 ${PASSWORD_MIN_LENGTH} 位）` : '请输入密码'} autoComplete={registering ? 'new-password' : 'current-password'} /></Form.Item>}
          {registering && site?.registration.requiresCode === true && <Form.Item name="inviteCode" label="邀请码" rules={[{ required: true, whitespace: true, message: '请输入邀请码' }]}><Input size="large" placeholder="请输入服务器邀请码" autoComplete="off" /></Form.Item>}
          <Form.Item className="auth-submit-item"><Button loading={loading} block type="primary" size="large" htmlType="submit">{registering ? '注册并登录' : '登录'}</Button></Form.Item>
        </Form>
        <div className="auth-switch-mode">
          {registering
            ? <button type="button" className="auth-switch-link" onClick={() => switchMode('login')}>已有账号？返回登录</button>
            : <>
                {registrationOpen && <button type="button" className="auth-switch-link" onClick={() => switchMode('register')}>还没有账号？注册</button>}
                {emailCodeLogin === 'optional' && <button type="button" className="auth-switch-link" onClick={() => { setLoginMode(loginMode === 'code' ? 'password' : 'code'); setError(''); setCodeNotice('') }}>{loginMode === 'code' ? '改用密码登录' : '改用邮箱验证码登录'}</button>}
                {loginMode === 'password' && <button type="button" className="auth-switch-link auth-switch-secondary" onClick={() => { setForgotOpen(true); setForgotPhase('request'); setForgotError(''); setForgotNotice('') }}>忘记密码？</button>}
              </>}
        </div>
      </Card>
    </section>
  </main>
  <Modal title="重置密码" open={forgotOpen} onCancel={() => setForgotOpen(false)} footer={null} destroyOnClose>
    {!emailEnabled && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="管理员尚未配置邮件服务器，暂时无法通过邮箱重置密码，请联系管理员。" />}
    {forgotError && <Alert type="error" showIcon message={forgotError} style={{ marginBottom: 16 }} />}
    {forgotNotice && <Alert type="success" showIcon message={forgotNotice} style={{ marginBottom: 16 }} />}
    <Form form={forgotForm} layout="vertical" requiredMark={false} disabled={!emailEnabled}>
      <Form.Item name="email" label="注册邮箱" rules={EMAIL_RULES}><Input size="large" placeholder="请输入注册时使用的邮箱" autoComplete="email" /></Form.Item>
      {forgotPhase === 'reset' && <>
        <Form.Item name="code" label="验证码" rules={[{ required: true, message: '请输入验证码' }]}><Input size="large" placeholder="邮件中的 6 位验证码" maxLength={6} /></Form.Item>
        <Form.Item name="password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: PASSWORD_MIN_LENGTH, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` }]}><Input.Password size="large" placeholder={`至少 ${PASSWORD_MIN_LENGTH} 位`} autoComplete="new-password" /></Form.Item>
      </>}
    </Form>
    <div className="auth-modal-actions">
      {forgotPhase === 'request'
        ? <Button type="primary" block loading={forgotBusy} disabled={!emailEnabled} onClick={() => void requestResetCode()}>发送验证码</Button>
        : <>
            <Button onClick={() => void requestResetCode()} loading={forgotBusy} disabled={!emailEnabled}>重新发送</Button>
            <Button type="primary" loading={forgotBusy} disabled={!emailEnabled} onClick={() => void submitReset()}>重置密码</Button>
          </>}
    </div>
  </Modal>
  <SiteFooter /></>
}
