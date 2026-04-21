import type { Mailer, MagicLinkMessage, RefundNoticeMessage, ContactMessage } from './types.ts'

export class ConsoleMailer implements Mailer {
  async sendMagicLink(msg: MagicLinkMessage): Promise<void> {
    const banner = '='.repeat(70)
    console.log(`\n${banner}`)
    console.log(`[ConsoleMailer] magic link for ${msg.email}`)
    console.log(`  expires: ${msg.expiresAt.toISOString()}`)
    console.log(`  url: ${msg.url}`)
    console.log(`${banner}\n`)
  }

  async sendRefundNotice(msg: RefundNoticeMessage): Promise<void> {
    console.log(JSON.stringify({ msg: 'refund-notice', to: msg.to, domain: msg.domain, kind: msg.kind }))
  }

  async sendContactMessage(msg: ContactMessage): Promise<void> {
    console.log(JSON.stringify({
      msg: 'contact-message',
      fromEmail: msg.fromEmail,
      category: msg.category,
      body: msg.body.length > 100 ? msg.body.slice(0, 100) + '…' : msg.body,
    }))
  }
}
