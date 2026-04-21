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

export interface ContactMessage {
  /** The user's email — they expect a reply at this address */
  fromEmail: string
  category: 'refund' | 'bug' | 'feature' | 'other'
  body: string
}

export interface Mailer {
  sendMagicLink(msg: MagicLinkMessage): Promise<void>
  sendRefundNotice(msg: RefundNoticeMessage): Promise<void>
  sendContactMessage(msg: ContactMessage): Promise<void>
}
