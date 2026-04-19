import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { serve, type ServerType } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { buildApp } from '../../src/server/app.ts'
import { registerRunGradeWorker } from '../../src/queue/workers/run-grade/index.ts'
import { MockProvider } from '../../src/llm/providers/mock.ts'
import { startTestDb, type TestDb } from './setup.ts'
import type { ScrapeResult } from '../../src/scraper/types.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import type { Queue } from 'bullmq'

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

const FIXTURE_SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: ('Acme widgets since 1902. Family-owned. Global distribution. ').repeat(10),
  structured: {
    jsonld: [],
    og: { title: 'Acme', description: 'Widgets', image: 'https://acme.com/og.png' },
    meta: { title: 'Acme Widgets', description: 'Industrial widgets since 1902.', canonical: 'https://acme.com', twitterCard: 'summary' },
    headings: { h1: ['Welcome'], h2: ['About'] },
    robots: null,
    sitemap: { present: true, url: 'https://acme.com/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
  },
}

function happyClaude(): MockProvider {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
      if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
      if (prompt.includes('You are evaluating how well')) return JSON.stringify({
        probe_1: { accuracy: 80, coverage: 75, notes: '' },
        probe_2: { accuracy: 70, coverage: 65, notes: '' },
        probe_3: { accuracy: 75, coverage: 70, notes: '' },
        probe_4: { accuracy: 65, coverage: 60, notes: '' },
      })
      if (prompt.includes('Do NOT reference')) return 'Which widget is best?'
      return 'Acme is the leading widget maker.'
    },
  })
}

function happyGpt(): MockProvider {
  return new MockProvider({
    id: 'gpt',
    responses: (prompt) => prompt.includes('Do NOT reference') ? 'Which brand leads?' : 'Acme is the go-to widget brand.',
  })
}

async function readSseUntilDone(
  response: Response,
  timeoutMs = 30_000,
): Promise<{ type: string; [k: string]: unknown }[]> {
  const events: { type: string; [k: string]: unknown }[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      const event = JSON.parse(dataLine.slice(6)) as { type: string }
      events.push(event)
      if (event.type === 'done' || event.type === 'failed') {
        await reader.cancel()
        return events
      }
    }
  }
  await reader.cancel()
  throw new Error(`SSE timed out after ${timeoutMs}ms (received ${events.length} events)`)
}

describe('SSE live lifecycle: full run', () => {
  it('POST /grades → open SSE → see running → scraped → probes → done', async () => {
    const serverRedis = createRedis(redisUrl)
    const workerRedis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const providers = {
      claude: happyClaude(), gpt: happyGpt(),
      gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
      perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
    }
    const worker = registerRunGradeWorker(
      { store, redis: workerRedis, providers, scrapeFn: async () => FIXTURE_SCRAPE },
      workerRedis,
    )

    const app = buildApp({
      store, redis: serverRedis,
      redisFactory: () => createRedis(redisUrl),
      mailer: new FakeMailer(),
      billing: null,
      reportQueue: {} as Queue,
      pingDb: async () => true,
      pingRedis: async () => true,
      env: {
        NODE_ENV: 'test',
        COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
        PUBLIC_BASE_URL: 'http://localhost:5173',
        STRIPE_PRICE_ID: null,
        STRIPE_WEBHOOK_SECRET: null,
        STRIPE_CREDITS_PRICE_ID: null,
      },
    })
    const server: ServerType = serve({ fetch: app.fetch, port: 0 })
    const port = (server.address() as AddressInfo).port
    const baseUrl = `http://localhost:${port}`

    try {
      const createRes = await fetch(`${baseUrl}/grades`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://acme.com' }),
      })
      expect(createRes.status).toBe(202)
      const { gradeId } = (await createRes.json()) as { gradeId: string }
      const setCookie = createRes.headers.get('set-cookie')
      const cookieHeader = setCookie?.split(';')[0] ?? ''

      const sseRes = await fetch(`${baseUrl}/grades/${gradeId}/events`, {
        headers: { cookie: cookieHeader, accept: 'text/event-stream' },
      })
      expect(sseRes.status).toBe(200)

      const events = await readSseUntilDone(sseRes, 45_000)
      expect(events[0]?.type).toBe('running')
      const scraped = events.find((e) => e.type === 'scraped')
      expect(scraped).toBeDefined()
      expect(events.filter((e) => e.type === 'probe.completed').length).toBeGreaterThan(20)
      expect(events.filter((e) => e.type === 'category.completed')).toHaveLength(6)
      expect(events[events.length - 1]?.type).toBe('done')

      const finalRes = await fetch(`${baseUrl}/grades/${gradeId}`, { headers: { cookie: cookieHeader } })
      expect(finalRes.status).toBe(200)
      const final = (await finalRes.json()) as { status: string; overall: number; letter: string }
      expect(final.status).toBe('done')
      expect(typeof final.overall).toBe('number')
      expect(final.letter).toBeTruthy()
    } finally {
      server.close()
      await worker.close()
      await serverRedis.quit()
      await workerRedis.quit()
    }
  }, 60_000)
})
