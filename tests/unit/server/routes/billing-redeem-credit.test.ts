import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { Queue } from 'bullmq'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'
type AppType = Hono<{ Variables: { cookie: string; clientIp: string } }>

function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe('whsec_test_fake')
  const fakeAdd = vi.fn().mockResolvedValue(undefined)
  const reportQueue = { add: fakeAdd } as unknown as Queue
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/billing', billingRouter({
    store, billing,
    priceId: 'price_test_report',
    creditsPriceId: 'price_test_credits',
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue,
  }))
  return { app, store, billing, fakeAdd }
}

async function issueCookie(app: AppType): Promise<string> {
  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gradeId: 'not-uuid' }),
  }))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie')
  return raw
}

async function seedVerifiedUserWithCredits(
  app: AppType, store: ReturnType<typeof makeFakeStore>, credits: number,
) {
  const cookie = await issueCookie(app)
  const uuid = cookie.split('.')[0]!
  const user = await store.upsertUser('u@x.com')
  await store.upsertCookie(uuid, user.id)
  if (credits > 0) {
    const sessionId = `cs_seed_${user.id}`
    await store.createStripePayment({
      gradeId: null, sessionId,
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid(sessionId, user.id, credits, 2900, 'usd')
  }
  return { cookie, uuid, user }
}

describe('POST /billing/redeem-credit', () => {
  it('happy path: decrements credits, writes audit row, enqueues generate-report', async () => {
    const { app, store, fakeAdd } = build()
    const { cookie, uuid, user } = await seedVerifiedUserWithCredits(app, store, 5)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })

    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(204)
    expect(await store.getCredits(user.id)).toBe(4)

    const payments = await store.listStripePaymentsByGrade(grade.id)
    const creditRow = payments.find((p) => p.kind === 'credits')
    expect(creditRow).toBeDefined()
    expect(creditRow!.status).toBe('paid')
    expect(creditRow!.amountCents).toBe(0)

    expect(fakeAdd).toHaveBeenCalledWith(
      'generate-report',
      expect.objectContaining({ gradeId: grade.id, sessionId: expect.stringContaining('credit:') }),
      expect.objectContaining({ jobId: `generate-report-credit-${grade.id}` }),
    )
  })

  it('404 on non-owned grade', async () => {
    const { app, store } = build()
    const { cookie } = await seedVerifiedUserWithCredits(app, store, 5)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: 'other', status: 'done',
    })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(404)
  })

  it('409 grade_not_done', async () => {
    const { app, store } = build()
    const { cookie, uuid } = await seedVerifiedUserWithCredits(app, store, 5)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'running',
    })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('grade_not_done')
  })

  it('409 must_verify_email when cookie is not bound', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('must_verify_email')
  })

  it('409 no_credits when balance is 0', async () => {
    const { app, store } = build()
    const { cookie, uuid } = await seedVerifiedUserWithCredits(app, store, 0)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('no_credits')
  })

  it('409 already_paid when a prior payment row exists', async () => {
    const { app, store } = build()
    const { cookie, uuid, user } = await seedVerifiedUserWithCredits(app, store, 5)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_prior',
      amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus('cs_prior', { status: 'paid' })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('already_paid')
    expect(await store.getCredits(user.id)).toBe(5)  // credit NOT spent
  })
})
