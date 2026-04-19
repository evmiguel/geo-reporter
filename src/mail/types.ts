export interface MagicLinkMessage {
  email: string
  url: string
  expiresAt: Date
}

export interface Mailer {
  sendMagicLink(msg: MagicLinkMessage): Promise<void>
}
