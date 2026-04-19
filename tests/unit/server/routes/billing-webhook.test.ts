import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Queue } from 'bullmq'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'

function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe()
  const fakeAdd = vi.fn().mockResolvedValue(undefined)
  const reportQueue = { add: fakeAdd } as unknown as Queue
  const app = new Hono()
  app.route('/billing', billingRouter({
    store, billing,
    priceId: 'price_test_abc',
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
      gradeId: grade.id, priceId: 'price_test_abc', successUrl: 's', cancelUrl: 'c',
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

  it('idempotent: duplicate webhook for already-paid session returns 200 and re-attempts enqueue with deterministic jobId (BullMQ dedups at queue layer)', async () => {
    const { app, store, billing, fakeAdd } = build()
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', status: 'done' })
    const session = await billing.createCheckoutSession({
      gradeId: grade.id, priceId: 'price_test_abc', successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd',
    })
    await store.updateStripePaymentStatus(session.id, { status: 'paid' })

    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      gradeId: grade.id,
      amountTotal: 1900,
      currency: 'usd',
    })
    // Fire webhook twice — simulates Stripe retry after hypothetical crash between
    // status-flip and enqueue. Both calls should attempt to enqueue; real BullMQ
    // dedups by jobId. The vi.fn() mock just records both calls.
    const res1 = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    const res2 = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    // fakeAdd IS called twice; the second call uses the same deterministic jobId.
    // Real BullMQ dedups by jobId; the mock just records both calls.
    expect(fakeAdd).toHaveBeenCalledTimes(2)
    expect(fakeAdd.mock.calls[0]![2]).toMatchObject({ jobId: `generate-report-${session.id}` })
    expect(fakeAdd.mock.calls[1]![2]).toMatchObject({ jobId: `generate-report-${session.id}` })
  })
})
