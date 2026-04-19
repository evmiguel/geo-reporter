import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { sql } from 'drizzle-orm'
import type Redis from 'ioredis'
import { Queue } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { buildApp } from '../../src/server/app.ts'
import { reportQueueName, type ReportJob } from '../../src/queue/queues.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { FakeStripe } from '../unit/_helpers/fake-stripe.ts'
import { startTestDb, type TestDb } from './setup.ts'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb
let redis: Redis
let billing: FakeStripe
let reportQueue: Queue<ReportJob>

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  testDb = await startTestDb()
}, 120_000)

afterAll(async () => {
  await reportQueue?.close()
  await redis?.quit()
  await testDb.stop()
  await redisContainer.stop()
})

beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, recommendations, reports, scrapes, probes, cookies, users, magic_tokens RESTART IDENTITY CASCADE`)
  if (reportQueue) await reportQueue.close()
  if (redis) await redis.quit()
  redis = createRedis(redisUrl)
  await redis.flushall()
  reportQueue = new Queue<ReportJob>(reportQueueName, { connection: redis })
  billing = new FakeStripe('whsec_test_fake')
})

function buildHarness() {
  return buildApp({
    store: new PostgresStore(testDb.db),
    redis,
    redisFactory: () => createRedis(redisUrl),
    mailer: new FakeMailer(),
    billing,
    reportQueue,
    pingDb: async () => true,
    pingRedis: async () => true,
    env: {
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      STRIPE_PRICE_ID: 'price_test_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
    },
  })
}

describe('POST /billing/webhook (integration)', () => {
  it('verifies signature + flips stripe_payments to paid + enqueues generate-report job', async () => {
    const app = buildHarness()
    const store = new PostgresStore(testDb.db)
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free', status: 'done',
    })
    const session = await billing.createCheckoutSession({
      gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'price_test_abc',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd',
    })
    billing.completeSession(session.id)

    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id, gradeId: grade.id,
      amountTotal: 1900, currency: 'usd',
    })

    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)

    const row = await store.getStripePaymentBySessionId(session.id)
    expect(row!.status).toBe('paid')

    // Assert a generate-report job landed in the queue
    const jobs = await reportQueue.getJobs(['waiting', 'active', 'delayed'])
    const found = jobs.find((j) => j.id === `generate-report-${session.id}`)
    expect(found).toBeDefined()
    expect(found!.data).toMatchObject({ gradeId: grade.id, sessionId: session.id })
  }, 60_000)

  it('duplicate webhook does not re-enqueue', async () => {
    const app = buildHarness()
    const store = new PostgresStore(testDb.db)
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free', status: 'done',
    })
    const session = await billing.createCheckoutSession({
      gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'price_test_abc',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd',
    })
    billing.completeSession(session.id)

    const ev1 = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id, gradeId: grade.id,
      amountTotal: 1900, currency: 'usd',
    })

    // First webhook call
    const res1 = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': ev1.signature, 'content-type': 'application/json' },
      body: ev1.body,
    }))
    expect(res1.status).toBe(200)

    // Second webhook call with a fresh event (same session) — tests the already-paid idempotency path
    const ev2 = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id, gradeId: grade.id,
      amountTotal: 1900, currency: 'usd',
    })
    const res2 = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': ev2.signature, 'content-type': 'application/json' },
      body: ev2.body,
    }))
    expect(res2.status).toBe(200)

    const jobs = await reportQueue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'])
    const matching = jobs.filter((j) => j.id === `generate-report-${session.id}`)
    expect(matching).toHaveLength(1) // webhook always attempts enqueue; BullMQ dedups by deterministic jobId
  }, 60_000)
})
