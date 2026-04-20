import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { Queue } from 'bullmq'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { makeStubRedis } from '../../_helpers/stub-redis.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'
type AppType = Hono<{ Variables: { cookie: string; clientIp: string } }>

function build(creditsPriceId = 'price_test_credits') {
  const store = makeFakeStore()
  const billing = new FakeStripe('whsec_test_fake')
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp({ trustedProxies: [], isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/billing', billingRouter({
    store, billing, redis: makeStubRedis(),
    priceId: 'price_test_report',
    creditsPriceId,
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue: null as unknown as Queue,
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
  if (!raw) throw new Error('no cookie')
  return raw
}

describe('POST /billing/buy-credits', () => {
  it('happy path: creates credits Stripe session + inserts pending row', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie(uuid, user.id)

    const res = await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toMatch(/^https:\/\/fake\.stripe\.test\//)
    expect(billing.createdSessions).toHaveLength(1)
    expect(billing.createdSessions[0]!.priceId).toBe('price_test_credits')
    expect(billing.createdSessions[0]!.kind).toBe('credits')
    expect(billing.createdSessions[0]!.userId).toBe(user.id)

    // Pending row inserted with kind='credits', gradeId null
    const creditsRow = [...store.stripePaymentsMap.values()].find((r) => r.kind === 'credits')
    expect(creditsRow).toBeDefined()
    expect(creditsRow!.status).toBe('pending')
    expect(creditsRow!.amountCents).toBe(2900)
    expect(creditsRow!.gradeId).toBeNull()
  })

  it('409 must_verify_email when cookie is not bound to a user', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)

    const res = await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('must_verify_email')
  })

  it('success URL is /?credits=purchased; cancel URL is /?credits=canceled', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie(uuid, user.id)

    await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    const input = billing.createdSessions[0]!
    expect(input.successUrl).toBe('http://localhost:5173/?credits=purchased')
    expect(input.cancelUrl).toBe('http://localhost:5173/?credits=canceled')
  })

  it('503 stripe_credits_not_configured when creditsPriceId is empty', async () => {
    const { app, store } = build('')
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie(uuid, user.id)

    const res = await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('stripe_credits_not_configured')
  })
})
