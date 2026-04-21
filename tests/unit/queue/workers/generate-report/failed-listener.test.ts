import { describe, it, expect } from 'vitest'
import type { Job } from 'bullmq'
import type { ReportJob } from '../../../../../src/queue/queues.ts'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'
import { FakeStripe } from '../../../_helpers/fake-stripe.ts'
import { FakeMailer } from '../../../_helpers/fake-mailer.ts'
import { makeStubRedis } from '../../../_helpers/stub-redis.ts'
import { handleGenerateReportFailure } from '../../../../../src/queue/workers/generate-report/failed-listener.ts'

// Fake BullMQ Job shape — only the fields the listener reads.
function makeJob(gradeId: string, attemptsMade: number, attempts: number): Job<ReportJob> {
  return {
    data: { gradeId },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ReportJob>
}

function setup() {
  const store = makeFakeStore()
  const billing = new FakeStripe()
  const mailer = new FakeMailer()
  const redis = makeStubRedis()
  return { store, billing, mailer, redis }
}

describe('handleGenerateReportFailure', () => {
  it('is a no-op on intermediate attempts (BullMQ will retry)', async () => {
    const { store, billing, mailer, redis } = setup()

    const grade = await store.createGrade({
      url: 'https://x.test',
      domain: 'x.test',
      tier: 'free',
      cookie: 'c-intermediate',
      userId: null,
      status: 'running',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_intermediate', amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus('cs_intermediate', { status: 'paid' })

    // attempt 2 of 3 failed — one retry left.
    const job = makeJob(grade.id, 1, 3)
    await handleGenerateReportFailure(job, new Error('transient'), { store, billing, mailer, redis })

    expect(billing.refunds).toHaveLength(0)
    expect(mailer.refundNotices).toHaveLength(0)
    const pay = await store.getStripePaymentBySessionId('cs_intermediate')
    expect(pay!.status).toBe('paid')
  })

  it('triggers auto-refund on the final attempt', async () => {
    const { store, billing, mailer, redis } = setup()

    const user = await store.upsertUser('final@example.com')
    await store.upsertCookie('c-final', user.id)
    const grade = await store.createGrade({
      url: 'https://x.test',
      domain: 'x.test',
      tier: 'free',
      cookie: 'c-final',
      userId: user.id,
      status: 'failed',
    })
    const session = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus(session.id, { status: 'paid' })

    // attempt 3 of 3 failed — retries exhausted.
    const job = makeJob(grade.id, 3, 3)
    await handleGenerateReportFailure(job, new Error('boom'), { store, billing, mailer, redis })

    expect(billing.refunds).toHaveLength(1)
    expect(billing.refunds[0]!.sessionId).toBe(session.id)
    const pay = await store.getStripePaymentBySessionId(session.id)
    expect(pay!.status).toBe('refunded')
    expect(mailer.refundNotices).toHaveLength(1)
    expect(mailer.refundNotices[0]!.kind).toBe('stripe')
  })

  it('swallows errors from autoRefundFailedReport so the worker keeps running', async () => {
    const { store, billing, mailer, redis } = setup()

    const grade = await store.createGrade({
      url: 'https://x.test',
      domain: 'x.test',
      tier: 'free',
      cookie: 'c-error',
      userId: null,
      status: 'failed',
    })
    // Force listStripePaymentsByGrade to throw, simulating a DB hiccup inside auto-refund.
    const originalList = store.listStripePaymentsByGrade.bind(store)
    store.listStripePaymentsByGrade = async () => { throw new Error('db exploded') }

    const job = makeJob(grade.id, 3, 3)
    // Should NOT throw — listener must isolate fatal failures so BullMQ stays healthy.
    await expect(
      handleGenerateReportFailure(job, new Error('boom'), { store, billing, mailer, redis }),
    ).resolves.toBeUndefined()

    store.listStripePaymentsByGrade = originalList
  })
})
