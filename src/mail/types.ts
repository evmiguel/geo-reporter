export interface MagicLinkMessage {
  email: string
  url: string
  expiresAt: Date
}

export interface RefundNoticeMessage {
  to: string
  domain: string
  kind: 'credit' | 'stripe'
}

export interface Mailer {
  sendMagicLink(msg: MagicLinkMessage): Promise<void>
  sendRefundNotice(msg: RefundNoticeMessage): Promise<void>
}
