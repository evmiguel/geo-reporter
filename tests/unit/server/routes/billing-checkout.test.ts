import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { makeStubRedis } from '../../_helpers/stub-redis.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

type AppType = Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>

function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe()
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
  app.use('*', clientIp({ isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/billing', billingRouter({
    store, billing, redis: makeStubRedis(),
    priceId: 'price_test_abc',
    creditsPriceId: 'price_test_credits',
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue: null as unknown as import('bullmq').Queue,
  }))
  return { app, store, billing }
}

async function issueCookie(app: AppType): Promise<string> {
  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gradeId: 'not-uuid' }),
  }))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

// Bind the issued cookie to a verified user so /checkout's must_verify_email
// guard passes. Tests of the verified-user happy paths share this helper.
async function verifyCookie(store: ReturnType<typeof makeFakeStore>, cookie: string, email = 'verified@example.com'): Promise<string> {
  const uuid = cookie.split('.')[0]!
  const user = await store.upsertUser(email)
  await store.upsertCookie(uuid, user.id)
  return uuid
}

describe('POST /billing/checkout', () => {
  it('happy path: creates session + inserts stripe_payments row', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = await verifyCookie(store, cookie)
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toMatch(/^https:\/\/fake\.stripe\.test\//)
    expect(billing.createdSessions).toHaveLength(1)
    expect(billing.createdSessions[0]!.gradeId).toBe(grade.id)
    const payments = await store.listStripePaymentsByGrade(grade.id)
    expect(payments).toHaveLength(1)
    expect(payments[0]!.status).toBe('pending')
  })

  it('404 on non-existent grade', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: '00000000-0000-0000-0000-000000000000' }),
    }))
    expect(res.status).toBe(404)
  })

  it('404 on non-owned grade', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: 'other-cookie', status: 'done' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(404)
  })

  it('409 grade_not_done', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'running' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('grade_not_done')
  })

  it('409 already_paid when stripe_payments has a paid row', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = await verifyCookie(store, cookie, 'paid@example.com')
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    await store.createStripePayment({ gradeId: grade.id, sessionId: 'cs_prior', amountCents: 1900, currency: 'usd' })
    await store.updateStripePaymentStatus('cs_prior', { status: 'paid' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; reportId: string }
    expect(body.error).toBe('already_paid')
    expect(body.reportId).toBe(grade.id)
  })

  it('resumes pending session when Stripe says it is still open', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = await verifyCookie(store, cookie, 'resume@example.com')
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    const prior = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'price_test_abc',
    })
    await store.createStripePayment({ gradeId: grade.id, sessionId: prior.id, amountCents: 1900, currency: 'usd' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toBe(prior.url)
    expect(billing.createdSessions).toHaveLength(1)
  })

  it('creates new session when prior pending session has expired at Stripe', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = await verifyCookie(store, cookie, 'expired@example.com')
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    const prior = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'price_test_abc',
    })
    await store.createStripePayment({ gradeId: grade.id, sessionId: prior.id, amountCents: 1900, currency: 'usd' })
    billing.expireSession(prior.id)
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(200)
    expect(billing.createdSessions).toHaveLength(2)
    const priorRow = await store.getStripePaymentBySessionId(prior.id)
    expect(priorRow!.status).toBe('failed')
  })

  it('server-side redeem when verified user already has credits (defense against stale client)', async () => {
    // Build the app with a real queue stub so the redeem path can enqueue.
    const store = makeFakeStore()
    const billing = new FakeStripe()
    const enqueued: Array<{ name: string; data: unknown; opts: unknown }> = []
    const reportQueue = {
      add: async (name: string, data: unknown, opts: unknown) => {
        enqueued.push({ name, data, opts })
      },
    } as unknown as import('bullmq').Queue
    const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
    app.use('*', clientIp({ isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
    app.route('/billing', billingRouter({
      store, billing, redis: makeStubRedis(),
      priceId: 'price_test_abc',
      creditsPriceId: 'price_test_credits',
      publicBaseUrl: 'http://localhost:5173',
      webhookSecret: 'whsec_test_fake',
      reportQueue,
    }))

    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    // Verified user with credits
    const user = await store.upsertUser('credits@example.com')
    await store.upsertCookie(uuid, user.id)
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_grant', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_grant', user.id, 10, 2900, 'usd')
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })

    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { redeemed?: boolean; url?: string }
    expect(body.redeemed).toBe(true)
    expect(body.url).toBeUndefined()
    // No Stripe session was created
    expect(billing.createdSessions).toHaveLength(0)
    // Credit was consumed (10 → 9)
    expect(await store.getCredits(user.id)).toBe(9)
    // generate-report was enqueued
    expect(enqueued).toHaveLength(1)
    expect((enqueued[0]!.data as { gradeId: string }).gradeId).toBe(grade.id)
  })

  it('409 provider_outage when grade has Claude/GPT terminal failures; no Stripe session created', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = await verifyCookie(store, cookie, 'outage@example.com')
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    await store.createProbe({
      gradeId: grade.id, category: 'discoverability', provider: 'gpt',
      prompt: '', response: '', score: null, metadata: { error: 'OpenAI 429' },
    })

    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))

    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('provider_outage')
    expect(billing.createdSessions).toHaveLength(0)
  })

  it('409 must_verify_email when cookie is not bound to a user', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    // Cookie row exists (created by middleware) but no userId — anonymous.
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('must_verify_email')
  })

  it('400 on missing / malformed body', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: 'not-a-uuid' }),
    }))
    expect(res.status).toBe(400)
  })
})
