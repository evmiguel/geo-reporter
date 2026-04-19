import type { Mailer, MagicLinkMessage } from './types.ts'

export class ConsoleMailer implements Mailer {
  async sendMagicLink(msg: MagicLinkMessage): Promise<void> {
    const banner = '='.repeat(70)
    console.log(`\n${banner}`)
    console.log(`[ConsoleMailer] magic link for ${msg.email}`)
    console.log(`  expires: ${msg.expiresAt.toISOString()}`)
    console.log(`  url: ${msg.url}`)
    console.log(`${banner}\n`)
  }
}
