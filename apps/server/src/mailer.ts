import { createTransport } from 'nodemailer'
import type { SmtpSettings } from './store.js'

export interface MailMessage { to: string; subject: string; text: string }
export type MailSender = (config: SmtpSettings, message: MailMessage) => Promise<void>

/** A usable SMTP configuration needs a host, a port and a sender address. */
export function smtpConfigured(config: SmtpSettings): boolean {
  return config.enabled === true && Boolean(config.host && config.port && config.from)
}

function transport(config: SmtpSettings) {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure === true,
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })
}

export const sendMail: MailSender = async (config, message) => {
  if (!smtpConfigured(config)) throw new Error('SMTP is not configured')
  await transport(config).sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text })
}

/** Probe the SMTP server without sending anything (admin "test connection"). */
export async function verifySmtp(config: SmtpSettings): Promise<void> {
  if (!smtpConfigured(config)) throw new Error('SMTP is not configured')
  const sender = transport(config)
  try { await sender.verify() } finally { sender.close() }
}
