import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import type { Queue, Worker } from 'bullmq'
import type Redis from 'ioredis'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { buildApp } from '../../src/server/app.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { createRedis } from '../../src/queue/redis.ts'
import { registerRunGradeWorker } from '../../src/queue/workers/run-grade/index.ts'
import { MockProvider } from '../../src/llm/providers/mock.ts'
import { shutdownBrowserPool } from '../../src/scraper/index.ts'
import type { ScrapeResult } from '../../src/scraper/types.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { startTestDb, type TestDb } from './setup.ts'

/**
 * Mirrors `scripts/smoke-prod.ts` but against testcontainers with MockProvider
 * instead of real LLM calls. A free-tier grade should complete end-to-end:
 * healthz → POST /grades → poll GET /grades/:id → done.
 *
 * This is the deploy smoke test — the single "the whole thing wires up and a
 * grade can run" sanity check. Finer-grained integration coverage lives in
 * `grades-events-live-full-run.test.ts`, `run-grade.test.ts`, etc.
 */

const FIXTURE_SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html><head><title>Example</title></head><body><h1>Example</h1></body></html>',
  text: (
    'Example Domain is used in illustrative examples in documents. It was founded in 1995 and is maintained by IANA. '
    + 'You may use this domain in literature without prior coordination or asking for permission. '
  ).repeat(8),
  structured: {
    jsonld: [{ '@type': 'Organization', name: 'Example' }],
    og: { title: 'Example', description: 'Example Domain', image: 'https://example.com/og.png' },
    meta: {
      title: 'Example Domain',
      description: 'Example Domain is used in illustrative examples in documents.',
      canonical: 'https://example.com',
      twitterCard: 'summary',
    },
    headings: { h1: ['Example Domain'], h2: ['About'] },
    robots: null,
    sitemap: { present: true, url: 'https://example.com/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://example.com/llms.txt' },
  },
}

function smokeClaude(): MockProvider {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('Write one specific factual question')) return 'When was Example Domain established?'
      if (prompt.includes('You are verifying')) {
        return JSON.stringify({ correct: true, confidence: 0.9, rationale: 'matches scrape' })
      }
      if (prompt.includes('You are evaluating how well')) {
        return JSON.stringify({
          probe_1: { accuracy: 80, coverage: 75, notes: '' },
          probe_2: { accuracy: 70, coverage: 65, notes: '' },
          probe_3: { accuracy: 75, coverage: 70, notes: '' },
          probe_4: { accuracy: 65, coverage: 60, notes: '' },
        })
      }
      if (prompt.includes('Do NOT reference')) return 'What domain is reserved for use in illustrative examples?'
      return 'Example Domain is reserved by IANA for use in illustrative examples in documents.'
    },
  })
}

function smokeGpt(): MockProvider {
  return new MockProvider({
    id: 'gpt',
    responses: (prompt) =>
      prompt.includes('Do NOT reference')
        ? 'Which domain is used for documentation examples?'
        : 'Example Domain is a reserved domain used for documentation examples.',
  })
}

describe('deploy smoke (testcontainers)', () => {
  let testDb: TestDb
  let redisContainer: StartedTestContainer
  let serverRedis: Redis
  let workerRedis: Redis
  let worker: Worker
  let app: Hono

  beforeAll(async () => {
    testDb = await startTestDb()
    redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
    serverRedis = createRedis(redisUrl)
    workerRedis = createRedis(redisUrl)

    const store = new PostgresStore(testDb.db)

    const providers = {
      claude: smokeClaude(),
      gpt: smokeGpt(),
      gemini: new MockProvider({
        id: 'gemini',
        responses: (prompt) =>
          prompt.includes('Do NOT reference')
            ? 'Which domain is reserved for documentation examples?'
            : 'Example Domain is reserved for illustrative examples.',
      }),
      perplexity: new MockProvider({
        id: 'perplexity',
        responses: (prompt) =>
          prompt.includes('Do NOT reference')
            ? 'What domain is reserved for examples in documentation?'
            : 'Example Domain is reserved by IANA for documentation examples.',
      }),
    }

    worker = registerRunGradeWorker(
      { store, redis: workerRedis, providers, scrapeFn: async () => FIXTURE_SCRAPE },
      workerRedis,
    )

    app = buildApp({
      store,
      redis: serverRedis,
      redisFactory: () => createRedis(redisUrl),
      mailer: new FakeMailer(),
      billing: null,
      reportQueue: {} as Queue,
      pingDb: async () => true,
      pingRedis: async () => true,
      env: {
        NODE_ENV: 'test',
        COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
        PUBLIC_BASE_URL: 'http://localhost',
        STRIPE_PRICE_ID: null,
        STRIPE_WEBHOOK_SECRET: null,
        STRIPE_CREDITS_PRICE_ID: null,
      },
    })
  }, 180_000)

  afterAll(async () => {
    await worker?.close().catch(() => undefined)
    await serverRedis?.quit().catch(() => undefined)
    await workerRedis?.quit().catch(() => undefined)
    await shutdownBrowserPool()
    await testDb?.stop()
    await redisContainer?.stop()
  })

  it('healthz + anon free-tier grade completes end-to-end', async () => {
    const hz = await app.request('/healthz')
    expect(hz.status).toBe(200)
    const hzBody = (await hz.json()) as { ok: boolean; db: boolean; redis: boolean }
    expect(hzBody.ok).toBe(true)

    const postRes = await app.request('/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(postRes.status).toBe(202)
    const setCookie = postRes.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    const cookie = setCookie!.split(';')[0]!
    const { gradeId } = (await postRes.json()) as { gradeId: string }
    expect(gradeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/i)

    // Poll until done (or failed) — MockProvider is fast but the full pipeline still runs.
    const start = Date.now()
    let lastStatus = 'queued'
    while (Date.now() - start < 60_000) {
      const r = await app.request(`/grades/${gradeId}`, { headers: { cookie } })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { status: string }
      lastStatus = body.status
      if (body.status === 'done' || body.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    const final = await app.request(`/grades/${gradeId}`, { headers: { cookie } })
    const body = (await final.json()) as { status: string; overall: number | null; letter: string | null }
    expect(body.status).toBe('done')
    expect(typeof body.overall).toBe('number')
    expect(body.letter).toBeTruthy()
  }, 120_000)
})
