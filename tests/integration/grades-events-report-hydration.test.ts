import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { serve, type ServerType } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Queue } from 'bullmq'
import type Redis from 'ioredis'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { buildApp } from '../../src/server/app.ts'
import { signCookie } from '../../src/server/middleware/cookie-sign.ts'
import { COOKIE_NAME } from '../../src/server/middleware/cookie.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { startTestDb, type TestDb } from './setup.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb
let redis: Redis
let server: ServerType | null = null

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
  await testDb.db.execute(sql`TRUNCATE grades, scrapes, probes, recommendations, reports, stripe_payments, cookies, users, magic_tokens RESTART IDENTITY CASCADE`)
  if (redis) await redis.quit()
  redis = createRedis(redisUrl)
  await redis.flushall()
})

afterEach(() => {
  if (server) {
    server.close()
    server = null
  }
})

function buildHarness() {
  return buildApp({
    store: new PostgresStore(testDb.db),
    redis,
    redisFactory: () => createRedis(redisUrl),
    mailer: new FakeMailer(),
    billing: null,
    reportQueue: {} as Queue,
    pingDb: async () => true,
    pingRedis: async () => true,
    env: {
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: HMAC_KEY,
      PUBLIC_BASE_URL: 'http://localhost:5173',
      STRIPE_PRICE_ID: null,
      STRIPE_WEBHOOK_SECRET: null,
      STRIPE_CREDITS_PRICE_ID: null,
    },
  })
}

async function readSseUntil(
  response: Response,
  terminalTypes: string[],
  timeoutMs = 10_000,
): Promise<{ type: string; [k: string]: unknown }[]> {
  const events: { type: string; [k: string]: unknown }[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) return events
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const payload = JSON.parse(dataLine.slice(6)) as { type: string }
        events.push(payload)
        if (terminalTypes.includes(payload.type)) {
          await reader.cancel()
          return events
        }
      }
    }
    throw new Error(`SSE timed out after ${timeoutMs}ms (received ${events.length} events, terminals=${terminalTypes.join(',')})`)
  } finally {
    try { await reader.cancel() } catch {}
  }
}

async function readSseExpectNoTerminal(
  response: Response,
  nonTerminalExpected: string,
  holdMs = 1_500,
): Promise<{ events: { type: string; [k: string]: unknown }[]; timedOut: boolean }> {
  const events: { type: string; [k: string]: unknown }[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawExpected = false
  const deadline = Date.now() + holdMs + 5_000
  try {
    while (Date.now() < deadline) {
      const readPromise = reader.read()
      const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), sawExpected ? holdMs : 5_000))
      const result = await Promise.race([readPromise, timer])
      if (result === 'timeout') {
        // Returning cleanly implies stream stayed open.
        return { events, timedOut: true }
      }
      const { value, done } = result
      if (done) return { events, timedOut: false }
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const payload = JSON.parse(dataLine.slice(6)) as { type: string }
        events.push(payload)
        if (payload.type === nonTerminalExpected) sawExpected = true
      }
    }
    return { events, timedOut: true }
  } finally {
    try { await reader.cancel() } catch {}
  }
}

async function seedGrade(opts: {
  tier: 'free' | 'paid'
  status: 'queued' | 'running' | 'done' | 'failed'
  cookieUuid: string
  overall?: number | null
  letter?: string | null
  scores?: Record<string, number | null> | null
}): Promise<string> {
  const store = new PostgresStore(testDb.db)
  await store.upsertCookie(opts.cookieUuid)
  const grade = await store.createGrade({
    url: 'https://acme.com',
    domain: 'acme.com',
    tier: opts.tier,
    cookie: opts.cookieUuid,
    userId: null,
    status: opts.status,
    ...(opts.overall !== undefined ? { overall: opts.overall } : {}),
    ...(opts.letter !== undefined ? { letter: opts.letter } : {}),
    ...(opts.scores !== undefined ? { scores: opts.scores } : {}),
  })
  return grade.id
}

async function seedScrape(gradeId: string): Promise<void> {
  const store = new PostgresStore(testDb.db)
  await store.createScrape({
    gradeId,
    rendered: false,
    html: '<html></html>',
    text: 'Acme widgets since 1902.',
    structured: {
      jsonld: [],
      og: { title: 'Acme', description: 'W', image: '' },
      meta: { title: 'Acme', description: 'W', canonical: '', twitterCard: 'summary' },
      headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  })
}

async function seedProbe(opts: {
  gradeId: string
  provider: string | null
  category: 'discoverability' | 'recognition' | 'coverage' | 'accuracy' | 'citation' | 'seo'
  label: string
  score: number | null
}): Promise<void> {
  const store = new PostgresStore(testDb.db)
  await store.createProbe({
    gradeId: opts.gradeId,
    category: opts.category,
    provider: opts.provider,
    prompt: 'p',
    response: 'r',
    score: opts.score,
    metadata: { label: opts.label, latencyMs: 123 },
  })
}

async function seedReport(gradeId: string, token = 'tok-abc'): Promise<string> {
  const store = new PostgresStore(testDb.db)
  const r = await store.createReport({ gradeId, token })
  return r.id
}

describe('SSE hydration — paid probes + report.done', () => {
  it('hydrates probe.completed + report.probe.completed + report.done for tier=paid grade with reports row', async () => {
    const cookieUuid = randomUUID()
    const gradeId = await seedGrade({
      tier: 'paid',
      status: 'done',
      cookieUuid,
      overall: 78,
      letter: 'B',
      scores: {
        discoverability: 80, recognition: 70, accuracy: 75, coverage: 85, citation: 60, seo: 90,
      },
    })
    await seedScrape(gradeId)
    // Free-tier probes
    await seedProbe({ gradeId, provider: 'claude', category: 'discoverability', label: 'claude-d', score: 80 })
    await seedProbe({ gradeId, provider: 'gpt', category: 'recognition', label: 'gpt-r', score: 72 })
    // Paid-tier probes
    await seedProbe({ gradeId, provider: 'gemini', category: 'discoverability', label: 'gemini-d', score: 65 })
    await seedProbe({ gradeId, provider: 'perplexity', category: 'recognition', label: 'perplexity-r', score: 70 })
    const reportId = await seedReport(gradeId, 'tok-happy')

    const app = buildHarness()
    server = serve({ fetch: app.fetch, port: 0 })
    const port = (server.address() as AddressInfo).port

    const signed = signCookie(cookieUuid, HMAC_KEY)
    const res = await fetch(`http://localhost:${port}/grades/${gradeId}/events`, {
      headers: {
        cookie: `${COOKIE_NAME}=${signed}`,
        accept: 'text/event-stream',
      },
    })
    expect(res.status).toBe(200)

    const events = await readSseUntil(res, ['report.done', 'report.failed', 'failed'], 15_000)
    const terminal = events[events.length - 1]
    expect(terminal?.type).toBe('report.done')
    expect((terminal as { reportId?: string }).reportId).toBe(reportId)
    expect((terminal as { token?: string }).token).toBe('tok-happy')

    // Free-tier probe.completed events
    const freeProbes = events.filter((e) => e.type === 'probe.completed')
    expect(freeProbes).toHaveLength(2)
    const providers = new Set(freeProbes.map((e) => (e as { provider?: string }).provider))
    expect(providers.has('claude')).toBe(true)
    expect(providers.has('gpt')).toBe(true)

    // Paid-tier report.probe.completed events
    const paidProbes = events.filter((e) => e.type === 'report.probe.completed')
    expect(paidProbes).toHaveLength(2)
    const paidProviders = new Set(paidProbes.map((e) => (e as { provider?: string }).provider))
    expect(paidProviders.has('gemini')).toBe(true)
    expect(paidProviders.has('perplexity')).toBe(true)

    // done event emitted before report.done
    const doneIdx = events.findIndex((e) => e.type === 'done')
    const reportDoneIdx = events.findIndex((e) => e.type === 'report.done')
    expect(doneIdx).toBeGreaterThanOrEqual(0)
    expect(reportDoneIdx).toBeGreaterThan(doneIdx)
  }, 30_000)

  it('keeps SSE stream open when tier=paid status=done but no reports row yet', async () => {
    const cookieUuid = randomUUID()
    const gradeId = await seedGrade({
      tier: 'paid',
      status: 'done',
      cookieUuid,
      overall: 78,
      letter: 'B',
      scores: {
        discoverability: 80, recognition: 70, accuracy: 75, coverage: 85, citation: 60, seo: 90,
      },
    })
    await seedProbe({ gradeId, provider: 'claude', category: 'discoverability', label: 'claude-d', score: 80 })
    // No reports row seeded — report is still being generated.

    const app = buildHarness()
    server = serve({ fetch: app.fetch, port: 0 })
    const port = (server.address() as AddressInfo).port

    const signed = signCookie(cookieUuid, HMAC_KEY)
    const res = await fetch(`http://localhost:${port}/grades/${gradeId}/events`, {
      headers: { cookie: `${COOKIE_NAME}=${signed}`, accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)

    const { events, timedOut } = await readSseExpectNoTerminal(res, 'done', 1_500)
    expect(timedOut).toBe(true) // stream stayed open — subscription alive
    expect(events.some((e) => e.type === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'report.done')).toBe(false)
    expect(events.some((e) => e.type === 'probe.completed')).toBe(true)
  }, 30_000)

  it('returns only done + hydration (no report.done) when tier=free status=done', async () => {
    const cookieUuid = randomUUID()
    const gradeId = await seedGrade({
      tier: 'free',
      status: 'done',
      cookieUuid,
      overall: 78,
      letter: 'B',
      scores: {
        discoverability: 80, recognition: 70, accuracy: 75, coverage: 85, citation: 60, seo: 90,
      },
    })
    await seedProbe({ gradeId, provider: 'claude', category: 'discoverability', label: 'claude-d', score: 80 })

    const app = buildHarness()
    server = serve({ fetch: app.fetch, port: 0 })
    const port = (server.address() as AddressInfo).port

    const signed = signCookie(cookieUuid, HMAC_KEY)
    const res = await fetch(`http://localhost:${port}/grades/${gradeId}/events`, {
      headers: { cookie: `${COOKIE_NAME}=${signed}`, accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)

    // Free tier done: subscription stays open (per-spec, user might have just paid).
    // We should still see done + probe.completed. Stream won't close on its own.
    const { events, timedOut } = await readSseExpectNoTerminal(res, 'done', 1_500)
    expect(timedOut).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'probe.completed')).toBe(true)
    expect(events.some((e) => e.type === 'report.probe.completed')).toBe(false)
    expect(events.some((e) => e.type === 'report.done')).toBe(false)
  }, 30_000)
})
