import type {
  Mailer, MagicLinkMessage, RefundNoticeMessage, ContactMessage, CrashAlert,
} from '../../../src/mail/types.ts'

export class FakeMailer implements Mailer {
  sent: MagicLinkMessage[] = []
  public readonly refundNotices: RefundNoticeMessage[] = []
  public readonly contactMessages: ContactMessage[] = []
  public readonly crashAlerts: CrashAlert[] = []

  async sendMagicLink(msg: MagicLinkMessage): Promise<void> {
    this.sent.push(msg)
  }

  async sendRefundNotice(msg: RefundNoticeMessage): Promise<void> {
    this.refundNotices.push(msg)
  }

  async sendContactMessage(msg: ContactMessage): Promise<void> {
    this.contactMessages.push(msg)
  }

  async sendCrashAlert(alert: CrashAlert): Promise<void> {
    this.crashAlerts.push(alert)
  }

  reset(): void {
    this.sent = []
    this.refundNotices.length = 0
    this.contactMessages.length = 0
    this.crashAlerts.length = 0
  }
}
