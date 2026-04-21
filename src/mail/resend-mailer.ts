import { Resend } from 'resend'
import type {
  Mailer, MagicLinkMessage, RefundNoticeMessage, ContactMessage, CrashAlert,
} from './types.ts'

interface ResendLikeClient {
  emails: {
    send: (opts: {
      from: string
      to: string
      subject: string
      text: string
      html: string
      replyTo?: string
    }) => Promise<{
      data: { id: string } | null
      error: { name: string; message: string } | null
    }>
  }
}

export interface ResendMailerOptions {
  apiKey: string
  from: string
  client?: ResendLikeClient
  /** Inbox for contact-form messages. Defaults to erika@erikamiguel.com. */
  contactInbox?: string
  /** Inbox for server crash alerts. Defaults to erika@erikamiguel.com. */
  alertInbox?: string
}

export class MailerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailerError'
  }
}

function fmtExpiry(d: Date): string {
  const minutes = Math.max(0, Math.round((d.getTime() - Date.now()) / 60_000))
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.round(minutes / 60)
  return `in ${hours} hr`
}

function htmlBody(url: string, expiresIn: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
    <h2 style="font-size:20px;margin-bottom:16px">Sign in to GEO Reporter</h2>
    <p>Click the link below to sign in. It expires ${expiresIn}.</p>
    <p><a href="${url}" style="display:inline-block;background:#ff7a1a;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">Sign in</a></p>
    <p style="color:#888;font-size:12px;margin-top:24px">If you didn't request this, you can ignore this email.</p>
  </body></html>`
}

function labelForCategory(c: ContactMessage['category']): string {
  switch (c) {
    case 'refund': return 'Refund issue'
    case 'bug': return 'Bug report'
    case 'feature': return 'Feature request'
    case 'other': return 'Question'
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export class ResendMailer implements Mailer {
  private readonly client: ResendLikeClient
  private readonly from: string
  private readonly contactInbox: string
  private readonly alertInbox: string

  constructor(opts: ResendMailerOptions) {
    this.client = opts.client ?? (new Resend(opts.apiKey) as unknown as ResendLikeClient)
    this.from = opts.from
    this.contactInbox = opts.contactInbox ?? 'erika@erikamiguel.com'
    this.alertInbox = opts.alertInbox ?? 'erika@erikamiguel.com'
  }

  async sendMagicLink(input: MagicLinkMessage): Promise<void> {
    const expiresIn = fmtExpiry(input.expiresAt)
    const { error } = await this.client.emails.send({
      from: this.from,
      to: input.email,
      subject: 'Sign in to GEO Reporter',
      text: `Click to sign in: ${input.url}\n\nThis link expires ${expiresIn}.`,
      html: htmlBody(input.url, expiresIn),
    })
    if (error) throw new MailerError(`resend: ${error.message}`)
  }

  async sendRefundNotice(msg: RefundNoticeMessage): Promise<void> {
    const subject = 'Your GEO Report refund'
    const intro = `Your GEO Report for ${msg.domain} couldn't be generated after three tries.`
    const detail = msg.kind === 'credit'
      ? "Your credit is back on your account — try again whenever you're ready."
      : 'Your $19 payment has been refunded to your card. It takes 5–10 business days to appear.'
    const text = `${intro}\n\n${detail}\n\nSorry about that. If you have questions, reply to this email.\n`
    const html = `<p>${intro}</p><p>${detail}</p><p>Sorry about that. If you have questions, reply to this email.</p>`
    const { error } = await this.client.emails.send({
      from: this.from,
      to: msg.to,
      subject,
      text,
      html,
    })
    if (error) throw new MailerError(`resend: ${error.message}`)
  }

  async sendContactMessage(msg: ContactMessage): Promise<void> {
    const subject = `[GEO Reporter] ${labelForCategory(msg.category)} from ${msg.fromEmail}`
    const text = `From: ${msg.fromEmail}\nCategory: ${msg.category}\n\n${msg.body}\n`
    const html = `<p><strong>From:</strong> ${escapeHtml(msg.fromEmail)}</p>` +
                 `<p><strong>Category:</strong> ${escapeHtml(msg.category)}</p>` +
                 `<hr/><p>${escapeHtml(msg.body).replace(/\n/g, '<br/>')}</p>`
    const { error } = await this.client.emails.send({
      from: this.from,
      to: this.contactInbox,
      replyTo: msg.fromEmail,
      subject,
      text,
      html,
    })
    if (error) throw new MailerError(`resend: ${error.message}`)
  }

  async sendCrashAlert(alert: CrashAlert): Promise<void> {
    const firstLine = alert.message.split('\n')[0] ?? alert.message
    const subject = `[GEO Reporter] ${alert.service} crash: ${firstLine.slice(0, 80)}`
    const text =
      `Service: ${alert.service}\n` +
      `Kind: ${alert.kind}\n` +
      `When: ${alert.timestamp.toISOString()}\n` +
      `Message: ${alert.message}\n\n` +
      `Stack:\n${alert.stack}\n`
    const html =
      `<p><strong>Service:</strong> ${escapeHtml(alert.service)}</p>` +
      `<p><strong>Kind:</strong> ${escapeHtml(alert.kind)}</p>` +
      `<p><strong>When:</strong> ${escapeHtml(alert.timestamp.toISOString())}</p>` +
      `<p><strong>Message:</strong> ${escapeHtml(alert.message)}</p>` +
      `<pre style="background:#f6f6f6;padding:12px;overflow-x:auto">${escapeHtml(alert.stack)}</pre>`
    const { error } = await this.client.emails.send({
      from: this.from,
      to: this.alertInbox,
      subject,
      text,
      html,
    })
    if (error) throw new MailerError(`resend: ${error.message}`)
  }
}
