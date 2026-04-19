import { createHmac } from 'node:crypto'
import type { BillingClient, CheckoutSession, CheckoutSessionInput, WebhookEvent } from '../../../src/billing/types.ts'

interface StoredSession extends CheckoutSession {
  _payment_intent?: string
}

export interface ConstructedWebhookEvent {
  body: string
  signature: string
}

export class FakeStripe implements BillingClient {
  readonly createdSessions: CheckoutSessionInput[] = []
  readonly sessions = new Map<string, StoredSession>()
  private counter = 0

  constructor(readonly webhookSecret: string = 'whsec_test_fake') {}

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    this.createdSessions.push(input)
    const id = `cs_test_fake_${++this.counter}_${input.gradeId}`
    const session: StoredSession = {
      id,
      url: `https://fake.stripe.test/${id}`,
      status: 'open',
      paymentStatus: 'unpaid',
      amountTotal: null,
      currency: null,
      metadata: { gradeId: input.gradeId },
      _payment_intent: `pi_test_fake_${this.counter}`,
    }
    this.sessions.set(id, session)
    return session
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`FakeStripe: unknown session ${sessionId}`)
    return session
  }

  completeSession(sessionId: string, amountTotal: number = 1900, currency: string = 'usd'): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`FakeStripe: unknown session ${sessionId}`)
    session.status = 'complete'
    session.paymentStatus = 'paid'
    session.amountTotal = amountTotal
    session.currency = currency
  }

  expireSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`FakeStripe: unknown session ${sessionId}`)
    session.status = 'expired'
  }

  constructEvent(input: {
    type: string
    sessionId: string
    gradeId: string
    amountTotal?: number
    currency?: string
    paymentIntent?: string
  }): ConstructedWebhookEvent {
    const event: WebhookEvent = {
      id: `evt_test_${this.counter++}`,
      type: input.type,
      data: {
        object: {
          id: input.sessionId,
          metadata: { gradeId: input.gradeId },
          ...(input.amountTotal !== undefined ? { amount_total: input.amountTotal } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.paymentIntent !== undefined ? { payment_intent: input.paymentIntent } : {}),
        },
      },
    }
    const body = JSON.stringify(event)
    const ts = Math.floor(Date.now() / 1000)
    const signedPayload = `${ts}.${body}`
    const sig = createHmac('sha256', this.webhookSecret).update(signedPayload).digest('hex')
    const signature = `t=${ts},v1=${sig}`
    return { body, signature }
  }

  verifyWebhookSignature(rawBody: string, signature: string, secret: string): WebhookEvent {
    if (secret !== this.webhookSecret) throw new Error('FakeStripe: webhook secret mismatch')
    const parts = new Map(signature.split(',').map((p) => {
      const eq = p.indexOf('=')
      return [p.slice(0, eq), p.slice(eq + 1)] as const
    }))
    const ts = parts.get('t')
    const v1 = parts.get('v1')
    if (!ts || !v1) throw new Error('FakeStripe: malformed signature')
    const signedPayload = `${ts}.${rawBody}`
    const expected = createHmac('sha256', secret).update(signedPayload).digest('hex')
    if (expected !== v1) throw new Error('FakeStripe: signature mismatch')
    return JSON.parse(rawBody) as WebhookEvent
  }
}
