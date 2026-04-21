import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { vi } from 'vitest'
import type { Queue } from 'bullmq'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { makeStubRedis } from '../../_helpers/stub-redis.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'
type AppType = Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>

async function issueCookie(app: AppType): Promise<string> {
  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gradeId: 'not-uuid' }),
  }))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('POST /billing/redeem-credit — rate limit', () => {
  it('returns 429 paywall=redeem_credit_throttled after 10 attempts within 1h', async () => {
    const store = makeFakeStore()
    const billing = new FakeStripe()
    const redis = makeStubRedis()
    const reportQueue = { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue

    const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
    app.use('*', clientIp({ isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
    app.route('/billing', billingRouter({
      store, billing, redis,
      priceId: 'price_test_report', creditsPriceId: 'price_test_credits',
      publicBaseUrl: 'http://localhost:5173',
      webhookSecret: 'whsec_test_fake',
      reportQueue,
    }))

    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('rd@example.com')
    await store.upsertCookie(uuid, user.id)
    // No credits granted — the endpoint will hit `no_credits` (409) on each
    // call, but rate-limit check runs FIRST so each attempt still counts.
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })

    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
        body: JSON.stringify({ gradeId: grade.id }),
      }))
      expect(res.status).not.toBe(429)
    }

    const blocked = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(blocked.status).toBe(429)
    const body = await blocked.json() as { error: string; paywall: string; retryAfter: number }
    expect(body.error).toBe('rate_limited')
    expect(body.paywall).toBe('redeem_credit_throttled')
    expect(typeof body.retryAfter).toBe('number')
  })
})
