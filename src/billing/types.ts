export interface CheckoutSessionInput {
  /** Which product the session is for. Stripe's server-side shape is identical; this drives metadata + `client_reference_id`. */
  kind: 'report' | 'credits'
  gradeId?: string    // present when kind === 'report'
  userId?: string     // present when kind === 'credits'
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
  metadata: { gradeId?: string; userId?: string; kind?: string; creditCount?: string }
}

export interface WebhookEvent {
  id: string
  type: string
  data: {
    object: {
      id: string
      metadata?: { gradeId?: string; userId?: string; kind?: string; creditCount?: string }
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
