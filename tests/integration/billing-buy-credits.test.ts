import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { sql } from 'drizzle-orm'
import type Redis from 'ioredis'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { buildApp } from '../../src/server/app.ts'
import { getReportQueue } from '../../src/queue/queues.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { FakeStripe } from '../unit/_helpers/fake-stripe.ts'
import { startTestDb, type TestDb } from './setup.ts'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb
let redis: Redis
let billing: FakeStripe

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  testDb = await startTestDb()
}, 120_000)

afterAll(async () => {
  await redis?.quit()
  await testDb.stop()
  await redisContainer.stop()
})

beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, cookies, users, magic_tokens CASCADE`)
  if (redis) await redis.quit()
  redis = createRedis(redisUrl)
  await redis.flushall()
  billing = new FakeStripe('whsec_test_fake')
})

function buildHarness() {
  return buildApp({
    store: new PostgresStore(testDb.db),
    redis,
    redisFactory: () => createRedis(redisUrl),
    mailer: new FakeMailer(),
    billing,
    reportQueue: getReportQueue(redis),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: {
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      STRIPE_PRICE_ID: 'price_test_report',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
      STRIPE_CREDITS_PRICE_ID: 'price_test_credits',
    },
  })
}

describe('POST /billing/webhook (integration) — credits branch', () => {
  it('grants credits after signed credits-checkout event', async () => {
    const app = buildHarness()
    const store = new PostgresStore(testDb.db)
    const user = await store.upsertUser('u@example.com')

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

    expect(await store.getCredits(user.id)).toBe(10)
    const row = await store.getStripePaymentBySessionId(session.id)
    expect(row!.status).toBe('paid')
    expect(row!.kind).toBe('credits')
  }, 60_000)
})
