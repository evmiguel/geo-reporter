import type {
  Mailer, MagicLinkMessage, RefundNoticeMessage, ContactMessage, CrashAlert,
} from './types.ts'

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

  async sendCrashAlert(alert: CrashAlert): Promise<void> {
    console.error(JSON.stringify({
      msg: 'crash-alert',
      service: alert.service,
      kind: alert.kind,
      message: alert.message,
      timestamp: alert.timestamp.toISOString(),
      stack: alert.stack,
    }))
  }
}
