import Stripe from 'stripe'
import type { BillingClient, CheckoutSession, CheckoutSessionInput, RefundResult, WebhookEvent } from './types.ts'

export interface StripeBillingClientOptions {
  secretKey: string
}

export class StripeBillingClient implements BillingClient {
  private readonly stripe: Stripe

  constructor(options: StripeBillingClientOptions) {
    this.stripe = new Stripe(options.secretKey, { apiVersion: '2025-02-24.acacia' })
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const metadata: Record<string, string> = { kind: input.kind }
    if (input.gradeId) metadata.gradeId = input.gradeId
    if (input.userId) metadata.userId = input.userId
    if (input.kind === 'credits') metadata.creditCount = '10'

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: input.priceId, quantity: 1 }],
      metadata,
      client_reference_id: input.gradeId ?? input.userId ?? '',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
    })
    return this.toSession(session)
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId)
    return this.toSession(session)
  }

  async refund(sessionId: string): Promise<RefundResult> {
    try {
      const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['payment_intent'],
      })
      const pi = session.payment_intent
      const piId = typeof pi === 'string' ? pi : pi?.id
      if (!piId) {
        return { ok: false, errorMessage: 'session has no payment_intent (probably not paid)' }
      }
      const refund = await this.stripe.refunds.create({ payment_intent: piId })
      return { ok: true, amountRefunded: refund.amount }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, errorMessage: `stripe refund: ${message}` }
    }
  }

  verifyWebhookSignature(rawBody: string, signature: string, secret: string): WebhookEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, secret)
    return {
      id: event.id,
      type: event.type,
      data: {
        object: event.data.object as WebhookEvent['data']['object'],
      },
    }
  }

  private toSession(session: Stripe.Checkout.Session): CheckoutSession {
    const raw = (session.metadata ?? {}) as Record<string, string | undefined>
    const metadata: CheckoutSession['metadata'] = {
      ...(raw.gradeId ? { gradeId: raw.gradeId } : {}),
      ...(raw.userId ? { userId: raw.userId } : {}),
      ...(raw.kind ? { kind: raw.kind } : {}),
      ...(raw.creditCount ? { creditCount: raw.creditCount } : {}),
    }
    return {
      id: session.id,
      url: session.url ?? '',
      status: (session.status ?? 'open') as CheckoutSession['status'],
      paymentStatus: session.payment_status as CheckoutSession['paymentStatus'],
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata,
    }
  }
}
