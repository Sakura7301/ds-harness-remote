// Password-only subset of upstream components/LoginPanel.tsx; keep its layout/classes.
// The self-hosted Server provisions one administrator from the environment and, when it
// allows registration, serves any additional accounts created from this panel.
import { Alert, Button, Card, Form, Input, Modal, Typography } from 'antd'
import { GithubOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import { api, type Account, type RegistrationInfo } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'
const PASSWORD_MIN_LENGTH = 12
export function LoginPanel({ onAuthSuccess, initialError }: { onAuthSuccess: (account: Account) => void; initialError?: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError ?? '')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [registration, setRegistration] = useState<RegistrationInfo>()
  const [forgotOpen, setForgotOpen] = useState(false)
  const [forgotPhase, setForgotPhase] = useState<'request' | 'reset'>('request')
  const [forgotBusy, setForgotBusy] = useState(false)
  const [forgotError, setForgotError] = useState('')
  const [forgotNotice, setForgotNotice] = useState('')
  const [forgotForm] = Form.useForm<{ email: string; code: string; password: string }>()
  const [form] = Form.useForm<{ email: string; password: string; code?: string }>()
  useEffect(() => {
    let cancelled = false
    api<RegistrationInfo>('/auth/registration')
      .then(info => { if (!cancelled) setRegistration(info) })
      .catch(() => { if (!cancelled) setRegistration({ enabled: false, requiresCode: false }) })
    return () => { cancelled = true }
  }, [])
  function switchMode(next: 'login' | 'register') {
    setMode(next); setError(''); form.resetFields(['password', 'code'])
  }
  async function submit(values: { email: string; password: string; code?: string }) {
    setLoading(true); setError('')
    try {
      const result = mode === 'register'
        ? await api<Account>('/auth/register', { email: values.email.trim(), password: values.password, ...(values.code === undefined || values.code.trim() === '' ? {} : { code: values.code.trim() }) })
        : await api<Account>('/auth/login', { email: values.email.trim(), password: values.password })
      form.resetFields(['password']); onAuthSuccess(result)
    } catch (err) { setError(err instanceof Error ? err.message : (mode === 'register' ? '注册失败，请重试。' : '登录失败，请重试。')) }
    finally { setLoading(false) }
  }
  async function requestResetCode() {
    setForgotBusy(true); setForgotError(''); setForgotNotice('')
    try {
      const values = await forgotForm.validateFields(['email'])
      await api('/auth/password/forgot', { email: values.email.trim() })
      setForgotPhase('reset')
      setForgotNotice('如果该邮箱已绑定账号，验证码已发送，10 分钟内有效。')
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
      <div className="auth-logo-stack"><a className="auth-home-link" href="/" aria-label="返回首页"><img className="auth-brand-icon" src="/brand-whale.webp" alt="" width="48" height="48" /><Typography.Title>DeepSeek Harness Remote</Typography.Title></a></div>
      <Card className="auth-panel">
        <div className="auth-intro"><Typography.Title level={3} className="auth-title">{registering ? '注册' : '登录'}</Typography.Title></div>
        {error && <Alert className="selfhost-auth-error" type="error" showIcon message={error} />}
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false} className="auth-form">
          <Form.Item name="email" label="账号" rules={[{ required: true, whitespace: true, message: '请输入账号' }, { max: 254, message: '账号不能超过 254 个字符' }]}><Input size="large" placeholder={registering ? '请输入用户名（字母/数字/._-）' : '请输入账号或邮箱'} autoComplete="username" /></Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { max: 1024, message: '密码不能超过 1024 个字符' }, ...(registering ? [{ min: PASSWORD_MIN_LENGTH, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` }] : [])]}><Input.Password size="large" placeholder={registering ? `请设置密码（至少 ${PASSWORD_MIN_LENGTH} 位）` : '请输入密码'} autoComplete={registering ? 'new-password' : 'current-password'} /></Form.Item>
          {registering && registration?.requiresCode === true && <Form.Item name="code" label="邀请码" rules={[{ required: true, whitespace: true, message: '请输入邀请码' }, { max: 256, message: '邀请码过长' }]}><Input size="large" placeholder="请输入服务器邀请码" autoComplete="off" /></Form.Item>}
          <Form.Item className="auth-submit-item"><Button loading={loading} block type="primary" size="large" htmlType="submit">{registering ? '注册并登录' : '登录'}</Button></Form.Item>
        </Form>
        <div className="auth-switch-mode">
          {registering
            ? <button type="button" className="auth-switch-link" onClick={() => switchMode('login')}>已有账号？返回登录</button>
            : <>
                {registration?.enabled === true && <button type="button" className="auth-switch-link" onClick={() => switchMode('register')}>还没有账号？注册</button>}
                <button type="button" className="auth-switch-link auth-switch-secondary" onClick={() => { setForgotOpen(true); setForgotPhase('request'); setForgotError(''); setForgotNotice('') }}>忘记密码？</button>
              </>}
        </div>
      </Card>
    </section>
  </main>
  <Modal title="重置密码" open={forgotOpen} onCancel={() => setForgotOpen(false)} footer={null} destroyOnClose>
    {forgotError && <Alert type="error" showIcon message={forgotError} style={{ marginBottom: 16 }} />}
    {forgotNotice && <Alert type="success" showIcon message={forgotNotice} style={{ marginBottom: 16 }} />}
    <Form form={forgotForm} layout="vertical" requiredMark={false}>
      <Form.Item name="email" label="绑定邮箱" rules={[{ required: true, whitespace: true, message: '请输入邮箱' }]}><Input size="large" placeholder="请输入账号绑定的邮箱" autoComplete="email" /></Form.Item>
      {forgotPhase === 'reset' && <>
        <Form.Item name="code" label="验证码" rules={[{ required: true, message: '请输入验证码' }]}><Input size="large" placeholder="邮件中的 6 位验证码" maxLength={6} /></Form.Item>
        <Form.Item name="password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: PASSWORD_MIN_LENGTH, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` }]}><Input.Password size="large" placeholder={`至少 ${PASSWORD_MIN_LENGTH} 位`} autoComplete="new-password" /></Form.Item>
      </>}
    </Form>
    <div className="auth-modal-actions">
      {forgotPhase === 'request'
        ? <Button type="primary" block loading={forgotBusy} onClick={() => void requestResetCode()}>发送验证码</Button>
        : <>
            <Button onClick={() => void requestResetCode()} loading={forgotBusy}>重新发送</Button>
            <Button type="primary" loading={forgotBusy} onClick={() => void submitReset()}>重置密码</Button>
          </>}
    </div>
  </Modal>
  <SiteFooter /></>
}
