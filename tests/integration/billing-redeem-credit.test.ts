import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { sql } from 'drizzle-orm'
import type Redis from 'ioredis'
import { QueueEvents } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { buildApp } from '../../src/server/app.ts'
import { getReportQueue, reportQueueName } from '../../src/queue/queues.ts'
import { registerGenerateReportWorker } from '../../src/queue/workers/generate-report/index.ts'
import { MockProvider } from '../../src/llm/providers/mock.ts'
import { signCookie } from '../../src/server/middleware/cookie-sign.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { FakeStripe } from '../unit/_helpers/fake-stripe.ts'
import { startTestDb, type TestDb } from './setup.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb
let redis: Redis

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
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, scrapes, probes, cookies, users, magic_tokens, recommendations, reports CASCADE`)
  if (redis) await redis.quit()
  redis = createRedis(redisUrl)
  await redis.flushall()
})

function makeProviders(): {
  claude: MockProvider
  gpt: MockProvider
  gemini: MockProvider
  perplexity: MockProvider
} {
  const recsJson = JSON.stringify([
    { title: 'r1', category: 'recognition', impact: 5, effort: 2, rationale: 'r', how: 'h' },
    { title: 'r2', category: 'seo', impact: 4, effort: 2, rationale: 'r', how: 'h' },
    { title: 'r3', category: 'accuracy', impact: 3, effort: 3, rationale: 'r', how: 'h' },
    { title: 'r4', category: 'citation', impact: 2, effort: 1, rationale: 'r', how: 'h' },
    { title: 'r5', category: 'coverage', impact: 4, effort: 4, rationale: 'r', how: 'h' },
  ])
  const claude = new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('GEO')) return recsJson
      if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
      if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
      if (prompt.includes('For each probe response below')) {
        const ids = Array.from(prompt.matchAll(/^(probe_\d+):$/gm)).map((m) => m[1])
        const obj: Record<string, { accuracy: number; coverage: number; notes: string }> = {}
        for (const id of ids) {
          if (id) obj[id] = { accuracy: 80, coverage: 80, notes: '' }
        }
        return JSON.stringify(obj)
      }
      return 'Acme widgets. Industrial leader.'
    },
  })
  return {
    claude,
    gpt: new MockProvider({ id: 'gpt', responses: () => 'Acme widgets' }),
    gemini: new MockProvider({ id: 'gemini', responses: () => 'Acme widgets' }),
    perplexity: new MockProvider({ id: 'perplexity', responses: () => 'Acme widgets' }),
  }
}

function buildHarness() {
  return buildApp({
    store: new PostgresStore(testDb.db),
    redis,
    redisFactory: () => createRedis(redisUrl),
    mailer: new FakeMailer(),
    billing: new FakeStripe('whsec_test_fake'),
    reportQueue: getReportQueue(redis),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: {
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: HMAC_KEY,
      PUBLIC_BASE_URL: 'http://localhost:5173',
      STRIPE_PRICE_ID: 'price_test_report',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
      STRIPE_CREDITS_PRICE_ID: 'price_test_credits',
    },
  })
}

describe('POST /billing/redeem-credit (integration) — full lifecycle', () => {
  it('redeems credit → worker runs → tier=paid, credits decrement, reports row written', async () => {
    const app = buildHarness()
    const store = new PostgresStore(testDb.db)

    const user = await store.upsertUser('u@example.com')
    const cookieUuid = crypto.randomUUID()
    await store.upsertCookie(cookieUuid, user.id)
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_seed',
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_seed', user.id, 3, 2900, 'usd')

    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free', status: 'done',
      overall: 70, letter: 'C', cookie: cookieUuid,
      scores: { recognition: 80, seo: 80, accuracy: 50, coverage: 70, citation: 70, discoverability: 60 },
    })
    await store.createScrape({
      gradeId: grade.id, rendered: false,
      html: '<html>Acme widgets</html>', text: 'Acme widgets since 1902. '.repeat(20),
      structured: {
        jsonld: [], og: { title: 'Acme', description: 'Widgets', image: 'https://acme.com/og.png' },
        meta: { title: 'Acme', description: 'W', canonical: 'https://acme.com', twitterCard: 'summary' },
        headings: { h1: ['Acme'], h2: [] },
        robots: null, sitemap: { present: true, url: '' }, llmsTxt: { present: false, url: '' },
      } as never,
    })
    await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'claude', prompt: 'p', response: 'acme', score: 80, metadata: {} })
    await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'gpt', prompt: 'p', response: 'acme', score: 70, metadata: {} })

    const worker = registerGenerateReportWorker({
      store, redis, providers: makeProviders(),
    }, redis)
    const queueEvents = new QueueEvents(reportQueueName, { connection: redis })
    await queueEvents.waitUntilReady()

    const signedCookie = signCookie(cookieUuid, HMAC_KEY)
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${signedCookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(204)

    const jobId = `generate-report-credit-${grade.id}`
    const reportQueue = getReportQueue(redis)
    const job = await reportQueue.getJob(jobId)
    expect(job).toBeDefined()
    await job!.waitUntilFinished(queueEvents, 60_000)

    const updated = await store.getGrade(grade.id)
    expect(updated!.tier).toBe('paid')
    expect(await store.getCredits(user.id)).toBe(2)
    const report = await store.getReport(grade.id)
    expect(report).not.toBeNull()

    await worker.close()
    await queueEvents.close()
    await reportQueue.close()
  }, 120_000)
})
