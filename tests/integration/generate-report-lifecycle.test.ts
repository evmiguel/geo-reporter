import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { sql } from 'drizzle-orm'
import type Redis from 'ioredis'
import { Queue, QueueEvents } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { reportQueueName, type ReportJob } from '../../src/queue/queues.ts'
import { registerGenerateReportWorker } from '../../src/queue/workers/generate-report/index.ts'
import { MockProvider } from '../../src/llm/providers/mock.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { startTestDb, type TestDb } from './setup.ts'

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
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, recommendations, reports, scrapes, probes, cookies, users, magic_tokens RESTART IDENTITY CASCADE`)
  if (redis) await redis.quit()
  redis = createRedis(redisUrl)
  await redis.flushall()
})

// Mock providers that return valid JSON-parseable recommendations for the recommender,
// and deterministic responses for the delta probes.
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
      // The recommender prompt is distinguishable by its opening phrase
      if (prompt.includes('GEO (Generative Engine Optimization) consultant')) return recsJson
      // Accuracy generator: produce a question
      if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
      // Accuracy verifier: mark correct
      if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
      // Coverage judge (returns per-probe JSON): map every key to a valid score
      if (prompt.includes('For each probe response below')) {
        // Extract probe IDs from the prompt
        const ids = Array.from(prompt.matchAll(/^(probe_\d+):$/gm)).map((m) => m[1])
        const obj: Record<string, { accuracy: number; coverage: number; notes: string }> = {}
        for (const id of ids) {
          if (id) obj[id] = { accuracy: 80, coverage: 80, notes: '' }
        }
        return JSON.stringify(obj)
      }
      return 'Acme widgets. Industrial. Leading in widgets.'
    },
  })
  const gpt = new MockProvider({ id: 'gpt', responses: () => 'Acme widget company' })
  const gemini = new MockProvider({ id: 'gemini', responses: () => 'Acme widgets, family-owned' })
  const perplexity = new MockProvider({ id: 'perplexity', responses: () => 'Acme provides widgets since 1902' })
  return { claude, gpt, gemini, perplexity }
}

describe('generate-report lifecycle (integration)', () => {
  it('end-to-end: free grade + delta probes + recommender + tier=paid', async () => {
    const store = new PostgresStore(testDb.db)

    // Seed a finished free grade
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free', status: 'done',
      overall: 70, letter: 'C',
      scores: { recognition: 80, seo: 80, accuracy: 50, coverage: 70, citation: 70, discoverability: 60 },
    })
    await store.createScrape({
      gradeId: grade.id, rendered: false,
      html: '<html>Acme widgets</html>',
      text: 'Acme widgets since 1902. Family-owned. Global distribution. '.repeat(10),
      structured: {
        jsonld: [], og: { title: 'Acme', description: 'Widgets', image: 'https://acme.com/og.png' },
        meta: { title: 'Acme', description: 'W', canonical: 'https://acme.com', twitterCard: 'summary' },
        headings: { h1: ['Acme'], h2: [] },
        robots: null,
        sitemap: { present: true, url: 'https://acme.com/sitemap.xml' },
        llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
      } as never,
    })
    await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'claude', prompt: 'p', response: 'acme widgets', score: 80, metadata: {} })
    await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'gpt', prompt: 'p', response: 'acme widgets', score: 70, metadata: {} })

    // Register the worker
    const worker = registerGenerateReportWorker(
      { store, redis, providers: makeProviders(), billing: null, mailer: new FakeMailer() },
      redis,
    )

    // Enqueue + wait for completion
    const queue = new Queue<ReportJob>(reportQueueName, { connection: redis })
    const queueEvents = new QueueEvents(reportQueueName, { connection: createRedis(redisUrl) })
    await queueEvents.waitUntilReady()
    try {
      const job = await queue.add(
        'generate-report',
        { gradeId: grade.id, sessionId: 'cs_test' },
        { jobId: `generate-report-cs_test`, attempts: 1 },
      )
      await job.waitUntilFinished(queueEvents, 90_000)

      // Assert DB state
      const updated = await store.getGrade(grade.id)
      expect(updated!.tier).toBe('paid')
      const probes = await store.listProbes(grade.id)
      expect(probes.filter((p) => p.provider === 'gemini').length).toBeGreaterThan(0)
      expect(probes.filter((p) => p.provider === 'perplexity').length).toBeGreaterThan(0)
      const recs = await store.listRecommendations(grade.id)
      expect(recs.length).toBeGreaterThanOrEqual(5)
      const report = await store.getReport(grade.id)
      expect(report).not.toBeNull()
      expect(report!.token).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await worker.close()
      await queueEvents.close()
      await queue.close()
    }
  }, 120_000)
})
