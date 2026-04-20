import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Queue } from 'bullmq'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { makeStubRedis } from '../../_helpers/stub-redis.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'

function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe()
  const fakeAdd = vi.fn().mockResolvedValue(undefined)
  const reportQueue = { add: fakeAdd } as unknown as Queue
  const app = new Hono()
  app.route('/billing', billingRouter({
    store, billing, redis: makeStubRedis(),
    priceId: 'price_test_abc',
    creditsPriceId: 'price_test_credits',
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue,
  }))
  return { app, store, billing, fakeAdd }
}

describe('POST /billing/webhook', () => {
  it('happy path: flips pending → paid + enqueues generate-report job', async () => {
    const { app, store, billing, fakeAdd } = build()
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', status: 'done' })
    const session = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id, priceId: 'price_test_abc', successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd',
    })
    billing.completeSession(session.id)

    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      gradeId: grade.id,
      amountTotal: 1900,
      currency: 'usd',
    })

    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)
    const row = await store.getStripePaymentBySessionId(session.id)
    expect(row!.status).toBe('paid')
    expect(fakeAdd).toHaveBeenCalledWith(
      'generate-report',
      { gradeId: grade.id, sessionId: session.id },
      expect.objectContaining({ jobId: `generate-report-${session.id}` }),
    )
  })

  it('400 on invalid signature', async () => {
    const { app } = build()
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(res.status).toBe(400)
  })

  it('200 no-op on unknown event type', async () => {
    const { app, billing, fakeAdd } = build()
    const { body, signature } = billing.constructEvent({
      type: 'payment_intent.succeeded',
      sessionId: 'cs_irrelevant',
      gradeId: '00000000-0000-0000-0000-000000000000',
    })
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)
    expect(fakeAdd).not.toHaveBeenCalled()
  })

  it('400 when metadata.gradeId missing', async () => {
    const { app, billing } = build()
    const baseEvent = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: 'cs_fake',
      gradeId: '00000000-0000-0000-0000-000000000000',
    })
    const parsed = JSON.parse(baseEvent.body)
    delete parsed.data.object.metadata
    const body = JSON.stringify(parsed)
    const { createHmac } = await import('node:crypto')
    const ts = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', 'whsec_test_fake').update(`${ts}.${body}`).digest('hex')
    const signature = `t=${ts},v1=${sig}`
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(400)
  })

  it('400 when stripe_payments row missing for session', async () => {
    const { app, billing } = build()
    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: 'cs_never_inserted',
      gradeId: '00000000-0000-0000-0000-000000000000',
    })
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(400)
  })

  it('idempotent: duplicate webhook for already-paid report session still re-attempts enqueue (BullMQ dedups)', async () => {
    const { app, store, billing, fakeAdd } = build()
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', status: 'done' })
    const session = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id,
      priceId: 'price_test_report', successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id,
      amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus(session.id, { status: 'paid' })  // already paid

    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      metadata: { kind: 'report', gradeId: grade.id },
      amountTotal: 1900, currency: 'usd',
    })
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)
    // Report branch: re-attempts enqueue on duplicate webhook. BullMQ will dedup by jobId in real runs.
    expect(fakeAdd).toHaveBeenCalledWith(
      'generate-report',
      { gradeId: grade.id, sessionId: session.id },
      expect.objectContaining({ jobId: `generate-report-${session.id}` }),
    )
  })
})

describe('POST /billing/webhook — credits branch', () => {
  it('happy path: grants credits + marks payment paid', async () => {
    const { app, store, billing, fakeAdd } = build()
    const user = await store.upsertUser('buyer@x.com')
    const session = await billing.createCheckoutSession({
      kind: 'credits', userId: user.id,
      priceId: 'price_test_credits',
      successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: null, sessionId: session.id,
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    billing.completeSession(session.id, 2900, 'usd')

    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      metadata: { kind: 'credits', userId: user.id, creditCount: '10' },
      amountTotal: 2900, currency: 'usd',
    })

    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)

    // Credits granted
    expect(await store.getCredits(user.id)).toBe(10)
    // Payment row flipped to paid, still kind='credits'
    const row = await store.getStripePaymentBySessionId(session.id)
    expect(row!.status).toBe('paid')
    expect(row!.kind).toBe('credits')
    // No report job enqueued
    expect(fakeAdd).not.toHaveBeenCalled()
  })

  it('400 on missing userId metadata for credits kind', async () => {
    const { app, store, billing } = build()
    const session = await billing.createCheckoutSession({
      kind: 'credits', userId: 'u-fake',
      priceId: 'price_test_credits',
      successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: null, sessionId: session.id,
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    billing.completeSession(session.id, 2900, 'usd')

    // Forge an event without userId
    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      metadata: { kind: 'credits', creditCount: '10' }, // no userId
      amountTotal: 2900, currency: 'usd',
    })

    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(400)
  })

  it('idempotent: duplicate credits webhook does not double-grant', async () => {
    const { app, store, billing } = build()
    const user = await store.upsertUser('buyer@x.com')
    const session = await billing.createCheckoutSession({
      kind: 'credits', userId: user.id,
      priceId: 'price_test_credits',
      successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: null, sessionId: session.id,
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    billing.completeSession(session.id, 2900, 'usd')

    const payload = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      metadata: { kind: 'credits', userId: user.id, creditCount: '10' },
      amountTotal: 2900, currency: 'usd',
    })

    await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': payload.signature, 'content-type': 'application/json' },
      body: payload.body,
    }))
    await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': payload.signature, 'content-type': 'application/json' },
      body: payload.body,
    }))
    // Credits granted exactly once
    expect(await store.getCredits(user.id)).toBe(10)
  })
})
