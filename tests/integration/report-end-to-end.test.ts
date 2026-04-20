import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import type { Worker } from 'bullmq'
import type { Queue } from 'bullmq'
import type Redis from 'ioredis'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { buildApp } from '../../src/server/app.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { registerRenderPdfWorker } from '../../src/report/pdf/worker.ts'
import { enqueuePdf } from '../../src/queue/queues.ts'
import { createRedis } from '../../src/queue/redis.ts'
import { getBrowserPool, shutdownBrowserPool } from '../../src/scraper/render.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('report end-to-end: generate -> render-pdf -> HTTP', () => {
  let testDb: TestDb
  let store: PostgresStore
  let app: Hono
  let redisContainer: StartedTestContainer
  let redisUrl: string
  let serverRedis: Redis
  let workerRedis: Redis
  let producerRedis: Redis
  let worker: Worker

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)

    redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
    redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`

    serverRedis = createRedis(redisUrl)
    workerRedis = createRedis(redisUrl)
    producerRedis = createRedis(redisUrl)

    worker = registerRenderPdfWorker({ store, browserPool: getBrowserPool() }, workerRedis)

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
    await producerRedis?.quit().catch(() => undefined)
    await shutdownBrowserPool()
    await testDb?.stop()
    await redisContainer?.stop()
  })

  it('seeds paid report, worker renders PDF, HTTP serves both HTML and PDF', async () => {
    const grade = await store.createGrade({
      url: 'https://example.test',
      domain: 'example.test',
      tier: 'paid',
      cookie: null,
      userId: null,
      status: 'done',
      overall: 82,
      letter: 'B',
      scores: {
        discoverability: 80, recognition: 85, accuracy: 75,
        coverage: 80, citation: 82, seo: 93,
      } as never,
    })

    await store.createScrape({
      gradeId: grade.id,
      rendered: false,
      html: '<html><body>example.test content</body></html>',
      text: 'example.test content',
      structured: {} as never,
    })

    await store.createProbe({
      gradeId: grade.id,
      category: 'discoverability',
      provider: 'claude',
      prompt: 'What is example.test?',
      response: 'An example domain.',
      score: 80,
      metadata: { label: 'self-gen', model: 'claude-sonnet-4-6' },
    })

    await store.createRecommendations([
      {
        gradeId: grade.id, rank: 1, category: 'recognition',
        title: 'Add structured data',
        impact: 4, effort: 2,
        rationale: 'Helps LLMs recognize the brand.',
        how: 'Add JSON-LD to the homepage.',
      },
    ])

    const token = 'e'.repeat(64)
    const report = await store.createReport({ gradeId: grade.id, token })
    await store.initReportPdfRow(report.id)

    await enqueuePdf({ reportId: report.id }, producerRedis)

    // Poll for the worker to finish — Playwright PDF rendering takes several seconds.
    const start = Date.now()
    let finalStatus: 'pending' | 'ready' | 'failed' | 'missing' = 'missing'
    while (Date.now() - start < 60_000) {
      const row = await store.getReportPdf(report.id)
      if (row?.status === 'ready') {
        finalStatus = 'ready'
        break
      }
      if (row?.status === 'failed') {
        finalStatus = 'failed'
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(finalStatus).toBe('ready')

    // HTML route
    const htmlRes = await app.request(`/report/${report.id}?t=${token}`)
    expect(htmlRes.status).toBe(200)
    expect(htmlRes.headers.get('content-type')).toContain('text/html')
    const html = await htmlRes.text()
    expect(html).toContain('example.test')

    // PDF route
    const pdfRes = await app.request(`/report/${report.id}.pdf?t=${token}`)
    expect(pdfRes.status).toBe(200)
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf')
    const pdfBytes = Buffer.from(await pdfRes.arrayBuffer())
    expect(pdfBytes.length).toBeGreaterThan(100)
    expect(pdfBytes.slice(0, 4).toString()).toBe('%PDF')
  }, 120_000)
})
