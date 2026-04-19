import type { Mailer, MagicLinkMessage } from '../../../src/mail/types.ts'

export class FakeMailer implements Mailer {
  sent: MagicLinkMessage[] = []

  async sendMagicLink(msg: MagicLinkMessage): Promise<void> {
    this.sent.push(msg)
  }

  reset(): void {
    this.sent = []
  }
}
