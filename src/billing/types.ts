export interface CheckoutSessionInput {
  gradeId: string
  successUrl: string
  cancelUrl: string
  priceId: string
}

export interface CheckoutSession {
  id: string
  url: string
  status: 'open' | 'complete' | 'expired'
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required'
  amountTotal: number | null
  currency: string | null
  metadata: { gradeId?: string }
}

export interface WebhookEvent {
  id: string
  type: string
  data: {
    object: {
      id: string
      metadata?: { gradeId?: string }
      amount_total?: number
      currency?: string
      payment_intent?: string
    }
  }
}

export interface BillingClient {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession>
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): WebhookEvent
}
