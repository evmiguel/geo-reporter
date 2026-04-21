import type { Mailer, MagicLinkMessage, RefundNoticeMessage } from '../../../src/mail/types.ts'

export class FakeMailer implements Mailer {
  sent: MagicLinkMessage[] = []
  public readonly refundNotices: RefundNoticeMessage[] = []

  async sendMagicLink(msg: MagicLinkMessage): Promise<void> {
    this.sent.push(msg)
  }

  async sendRefundNotice(msg: RefundNoticeMessage): Promise<void> {
    this.refundNotices.push(msg)
  }

  reset(): void {
    this.sent = []
    this.refundNotices.length = 0
  }
}
