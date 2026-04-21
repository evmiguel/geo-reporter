import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'
import { FakeStripe } from '../../../_helpers/fake-stripe.ts'
import { FakeMailer } from '../../../_helpers/fake-mailer.ts'
import { makeStubRedis } from '../../../_helpers/stub-redis.ts'
import { autoRefundFailedReport } from '../../../../../src/queue/workers/generate-report/auto-refund.ts'

describe('autoRefundFailedReport', () => {
  function setup() {
    const store = makeFakeStore()
    const billing = new FakeStripe()
    const mailer = new FakeMailer()
    const redis = makeStubRedis()
    return { store, billing, mailer, redis }
  }

  it('skips when no paid stripe_payments exists for the grade', async () => {
    const { store, billing, mailer, redis } = setup()
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie: 'c', userId: null, status: 'failed',
    })
    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('skipped_not_paid')
    expect(billing.refunds).toHaveLength(0)
    expect(mailer.refundNotices).toHaveLength(0)
  })

  it('skips when payment was already refunded (idempotent)', async () => {
    const { store, billing, mailer, redis } = setup()
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie: 'c', userId: null, status: 'failed',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_done', amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus('cs_done', { status: 'refunded' })
    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('skipped_not_paid')
    expect(billing.refunds).toHaveLength(0)
    expect(mailer.refundNotices).toHaveLength(0)
  })

  it('issues Stripe refund for kind=report, marks status=refunded, emails user', async () => {
    const { store, billing, mailer, redis } = setup()
    const user = await store.upsertUser('refund@example.com')
    await store.upsertCookie('c-refund', user.id)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'example.com', tier: 'free',
      cookie: 'c-refund', userId: user.id, status: 'failed',
    })
    const session = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus(session.id, { status: 'paid' })

    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('stripe_refunded')
    expect(billing.refunds).toHaveLength(1)
    expect(billing.refunds[0]!.sessionId).toBe(session.id)

    const pay = await store.getStripePaymentBySessionId(session.id)
    expect(pay!.status).toBe('refunded')

    expect(mailer.refundNotices).toHaveLength(1)
    expect(mailer.refundNotices[0]!.kind).toBe('stripe')
    expect(mailer.refundNotices[0]!.to).toBe('refund@example.com')
    expect(mailer.refundNotices[0]!.domain).toBe('example.com')

    // SSE event published.
    const events = redis.published
      .filter((p) => p.channel === `grade:${grade.id}`)
      .map((p) => JSON.parse(p.message) as { type: string; refundKind?: string })
    expect(events.some((e) => e.type === 'report.refunded' && e.refundKind === 'stripe')).toBe(true)
  })

  it('marks status=refund_pending when Stripe refund fails; no user email, no SSE', async () => {
    const { store, billing, mailer, redis } = setup()
    const user = await store.upsertUser('pending@example.com')
    await store.upsertCookie('c-pending', user.id)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'example.com', tier: 'free',
      cookie: 'c-pending', userId: user.id, status: 'failed',
    })
    const session = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus(session.id, { status: 'paid' })
    billing.failRefundsFor(session.id)

    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('refund_pending')
    expect(result.errorMessage).toBeTruthy()

    const pay = await store.getStripePaymentBySessionId(session.id)
    expect(pay!.status).toBe('refund_pending')
    // Don't email the user "we're still processing your refund" — confusing copy.
    expect(mailer.refundNotices).toHaveLength(0)
    // No report.refunded SSE until the refund actually lands.
    const refundedEvents = redis.published
      .filter((p) => p.channel === `grade:${grade.id}`)
      .map((p) => JSON.parse(p.message) as { type: string })
      .filter((e) => e.type === 'report.refunded')
    expect(refundedEvents).toHaveLength(0)
  })

  it('grants credit for kind=credits, increments user.credits, emits SSE + email', async () => {
    const { store, billing, mailer, redis } = setup()
    const user = await store.upsertUser('credit-refund@example.com')
    await store.upsertCookie('c-credit-refund', user.id)
    // Seed 5 credits via a credits-pack purchase.
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_pack', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_pack', user.id, 5, 2900, 'usd')
    // Simulate redeem → credits decremented to 4.
    const redeem = await store.redeemCredit(user.id)
    expect(redeem.ok).toBe(true)
    expect(await store.getCredits(user.id)).toBe(4)

    const grade = await store.createGrade({
      url: 'https://x', domain: 'example.com', tier: 'free',
      cookie: 'c-credit-refund', userId: user.id, status: 'failed',
    })
    // Audit row written by /billing/redeem-credit — sessionId shape matches billing.ts (`credit:<gradeId>`).
    const auditSessionId = `credit:${grade.id}`
    await store.createStripePayment({
      gradeId: grade.id, sessionId: auditSessionId, amountCents: 0, currency: 'usd',
      kind: 'credits', userId: user.id,
    })
    await store.updateStripePaymentStatus(auditSessionId, { status: 'paid' })

    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('credit_granted')
    expect(await store.getCredits(user.id)).toBe(5)

    const pay = await store.getStripePaymentBySessionId(auditSessionId)
    expect(pay!.status).toBe('refunded')
    // No Stripe call for credit refunds.
    expect(billing.refunds).toHaveLength(0)
    expect(mailer.refundNotices).toHaveLength(1)
    expect(mailer.refundNotices[0]!.kind).toBe('credit')
    expect(mailer.refundNotices[0]!.to).toBe('credit-refund@example.com')

    const events = redis.published
      .filter((p) => p.channel === `grade:${grade.id}`)
      .map((p) => JSON.parse(p.message) as { type: string; refundKind?: string })
    expect(events.some((e) => e.type === 'report.refunded' && e.refundKind === 'credit')).toBe(true)
  })
})
