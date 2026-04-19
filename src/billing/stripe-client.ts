import Stripe from 'stripe'
import type { BillingClient, CheckoutSession, CheckoutSessionInput, WebhookEvent } from './types.ts'

export interface StripeBillingClientOptions {
  secretKey: string
}

export class StripeBillingClient implements BillingClient {
  private readonly stripe: Stripe

  constructor(options: StripeBillingClientOptions) {
    this.stripe = new Stripe(options.secretKey, { apiVersion: '2025-02-24.acacia' })
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: input.priceId, quantity: 1 }],
      metadata: { gradeId: input.gradeId },
      client_reference_id: input.gradeId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    })
    return this.toSession(session)
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId)
    return this.toSession(session)
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
    return {
      id: session.id,
      url: session.url ?? '',
      status: (session.status ?? 'open') as CheckoutSession['status'],
      paymentStatus: session.payment_status as CheckoutSession['paymentStatus'],
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: { ...(session.metadata?.gradeId != null ? { gradeId: session.metadata.gradeId } : {}) },
    }
  }
}
