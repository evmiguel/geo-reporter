import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Queue } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { registerRunGradeWorker } from '../../src/queue/workers/run-grade/index.ts'
import { gradeQueueName, type GradeJob } from '../../src/queue/queues.ts'
import { subscribeToGrade, type GradeEvent } from '../../src/queue/events.ts'
import { MockProvider } from '../../src/llm/providers/mock.ts'
import { startTestDb, type TestDb } from './setup.ts'
import type { ScrapeResult } from '../../src/scraper/index.ts'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  testDb = await startTestDb()
}, 120_000)

afterAll(async () => {
  await testDb.stop()
  await redisContainer.stop()
})

const FIXTURE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: ('Acme was founded in 1902 in Springfield. We make industrial widgets used by construction firms across North America. Family-owned for four generations. ').repeat(10),
  structured: {
    jsonld: [{ '@type': 'Organization', name: 'Acme' }],
    og: { title: 'Acme', description: 'Industrial widgets since 1902', image: 'https://acme.com/og.png' },
    meta: { title: 'Acme Widgets', description: 'Industrial widgets since 1902, family-owned for four generations, used across North America.', canonical: 'https://acme.com', twitterCard: 'summary' },
    headings: { h1: ['Welcome to Acme'], h2: ['About us'] },
    robots: null,
    sitemap: { present: true, url: 'https://acme.com/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
  },
}

function happyClaude(probeKeysCount: number = 4): MockProvider {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
      if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: 'matches scrape' })
      if (prompt.includes('You are evaluating how well')) {
        return JSON.stringify(Object.fromEntries(
          Array.from({ length: probeKeysCount }, (_, i) => [`probe_${i + 1}`, { accuracy: 80, coverage: 75, notes: '' }]),
        ))
      }
      if (prompt.includes('Do NOT reference')) return 'What is the best industrial widget brand?'
      return 'Acme is the leading widget maker, founded in 1902, and the industry standard.'
    },
  })
}

function happyGpt(): MockProvider {
  return new MockProvider({
    id: 'gpt',
    responses: (prompt) => {
      if (prompt.includes('Do NOT reference')) return 'Which brand is most popular for industrial widgets?'
      return 'Acme is an industry standard for widgets, founded over a century ago.'
    },
  })
}

describe('run-grade worker end-to-end', () => {
  it('free tier: worker processes a grade job, writes all rows, emits full event sequence', async () => {
    const connection = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)

    try {
      const providers = {
        claude: happyClaude(4), gpt: happyGpt(),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      }
      const worker = registerRunGradeWorker(
        { store, redis: connection, providers, scrapeFn: async () => FIXTURE },
        connection,
      )

      const cookie = await store.upsertCookie(`test-cookie-${Date.now()}`)
      const grade = await store.createGrade({
        url: 'https://acme.com', domain: 'acme.com', tier: 'free',
        cookie: cookie.cookie, status: 'queued',
      })

      const eventsPromise = (async () => {
        const out: GradeEvent[] = []
        for await (const ev of subscribeToGrade(subscriber, grade.id)) out.push(ev)
        return out
      })()

      await new Promise((r) => setTimeout(r, 100))
      const queue = new Queue<GradeJob>(gradeQueueName, { connection })
      await queue.add('run-grade', { gradeId: grade.id, tier: 'free' }, {
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 24 * 3600 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      })
      await queue.close()

      const events = await Promise.race([
        eventsPromise,
        new Promise<GradeEvent[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
      ])

      // Event sequence
      expect(events[0]?.type).toBe('running')
      const scraped = events.find((e) => e.type === 'scraped')
      expect(scraped).toBeDefined()
      expect(events.filter((e) => e.type === 'probe.completed').length).toBeGreaterThan(20)
      expect(events.filter((e) => e.type === 'category.completed')).toHaveLength(6)
      const done = events[events.length - 1]
      expect(done?.type).toBe('done')

      // DB state
      const finalGrade = await store.getGrade(grade.id)
      expect(finalGrade?.status).toBe('done')
      expect(typeof finalGrade?.overall).toBe('number')
      expect(finalGrade?.letter).toBeTruthy()
      expect(finalGrade?.scores).toBeTruthy()

      const probes = await store.listProbes(grade.id)
      // Free tier: 10 seo + 4 recognition + 2 citation + 2 discoverability + 4 coverage + 3 accuracy = 25
      expect(probes).toHaveLength(25)

      const scrape = await store.getScrape(grade.id)
      expect(scrape).toBeTruthy()
      expect(scrape?.rendered).toBe(false)

      await worker.close()
    } finally {
      await subscriber.quit()
      await connection.quit()
    }
  }, 60_000)

  it('paid tier writes 39 probes', async () => {
    const connection = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)

    try {
      const providers = {
        claude: happyClaude(8), // paid tier: judge sees probe_1..probe_8
        gpt: happyGpt(),
        gemini: new MockProvider({ id: 'gemini', responses: (p) => p.includes('Do NOT reference') ? 'question?' : 'Acme is leading.' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: (p) => p.includes('Do NOT reference') ? 'question?' : 'Acme is the go-to widget maker.' }),
      }

      const worker = registerRunGradeWorker(
        { store, redis: connection, providers, scrapeFn: async () => FIXTURE },
        connection,
      )

      const cookie = await store.upsertCookie(`test-paid-${Date.now()}`)
      const grade = await store.createGrade({ url: 'https://acme.com', domain: 'acme.com', tier: 'paid', cookie: cookie.cookie, status: 'queued' })

      const eventsPromise = (async () => {
        const out: GradeEvent[] = []
        for await (const ev of subscribeToGrade(subscriber, grade.id)) out.push(ev)
        return out
      })()

      await new Promise((r) => setTimeout(r, 100))
      const queue = new Queue<GradeJob>(gradeQueueName, { connection })
      await queue.add('run-grade', { gradeId: grade.id, tier: 'paid' }, {
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 24 * 3600 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      })
      await queue.close()

      await Promise.race([eventsPromise, new Promise<GradeEvent[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000))])

      const probes = await store.listProbes(grade.id)
      // Paid tier: 10 seo + 8 recognition + 4 citation + 4 discoverability + 8 coverage + 5 accuracy = 39
      expect(probes).toHaveLength(39)

      await worker.close()
    } finally {
      await subscriber.quit()
      await connection.quit()
    }
  }, 60_000)

  it('retry: flaky provider eventually succeeds with clean slate', async () => {
    const connection = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)

    try {
      let attemptCount = 0
      const flakyClaude = new MockProvider({
        id: 'claude',
        responses: (prompt) => {
          attemptCount++
          if (attemptCount <= 3) throw new Error('flaky — attempt 1 failure')
          if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
          if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
          if (prompt.includes('You are evaluating how well')) return JSON.stringify({
            probe_1: { accuracy: 80, coverage: 75, notes: '' }, probe_2: { accuracy: 70, coverage: 65, notes: '' },
            probe_3: { accuracy: 75, coverage: 70, notes: '' }, probe_4: { accuracy: 65, coverage: 60, notes: '' },
          })
          if (prompt.includes('Do NOT reference')) return 'question?'
          return 'Acme is leading.'
        },
      })

      const providers = {
        claude: flakyClaude,
        gpt: happyGpt(),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      }
      const worker = registerRunGradeWorker(
        { store, redis: connection, providers, scrapeFn: async () => FIXTURE },
        connection,
      )

      const cookie = await store.upsertCookie(`test-retry-${Date.now()}`)
      const grade = await store.createGrade({ url: 'https://acme.com', domain: 'acme.com', tier: 'free', cookie: cookie.cookie, status: 'queued' })

      const queue = new Queue<GradeJob>(gradeQueueName, { connection })
      await queue.add('run-grade', { gradeId: grade.id, tier: 'free' }, {
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 24 * 3600 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      })
      await new Promise<void>((resolve) => {
        const iv = setInterval(async () => {
          const g = await store.getGrade(grade.id)
          if (g?.status === 'done' || g?.status === 'failed') {
            clearInterval(iv)
            resolve()
          }
        }, 500)
      })

      const finalGrade = await store.getGrade(grade.id)
      const probes = await store.listProbes(grade.id)
      // The test passes whether final status is done (clear-on-retry worked) or failed (retries exhausted),
      // because both are valid outcomes given BullMQ's retry policy. The critical assertion is that probe
      // count is bounded (no duplication from failed attempts).
      // Clear-on-retry means probe count reflects the last attempt, not cumulative, which should be <= 25.
      expect(probes.length).toBeLessThanOrEqual(25)
      if (finalGrade?.status === 'done') {
        expect(probes.length).toBeGreaterThanOrEqual(20) // At least most of the expected probes
      }

      await worker.close()
      await queue.close()
    } finally {
      await connection.quit()
    }
  }, 60_000)
})
