import { Resend } from 'resend'
import type { Mailer, MagicLinkMessage } from './types.ts'

interface ResendLikeClient {
  emails: {
    send: (opts: {
      from: string
      to: string
      subject: string
      text: string
      html: string
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

export class ResendMailer implements Mailer {
  private readonly client: ResendLikeClient
  private readonly from: string

  constructor(opts: ResendMailerOptions) {
    this.client = opts.client ?? (new Resend(opts.apiKey) as unknown as ResendLikeClient)
    this.from = opts.from
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
}
