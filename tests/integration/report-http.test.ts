import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../../src/server/app.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'
import IORedisMock from 'ioredis-mock'

async function seedPaidReport(store: PostgresStore): Promise<{ reportId: string; token: string }> {
  const grade = await store.createGrade({
    url: 'https://stripe.com', domain: 'stripe.com', tier: 'paid',
    cookie: null, userId: null, status: 'done', overall: 87, letter: 'B+',
    scores: { discoverability: 78, recognition: 85, accuracy: 62, coverage: 71, citation: 80, seo: 93 } as never,
  })
  await store.createScrape({ gradeId: grade.id, rendered: false, html: '<html></html>', text: 'hi', structured: {} as never })
  const token = 'x'.repeat(64)
  const report = await store.createReport({ gradeId: grade.id, token })
  return { reportId: report.id, token }
}

function buildTestApp(store: PostgresStore): Hono {
  return buildApp({
    store,
    redis: new IORedisMock() as never,
    redisFactory: () => new IORedisMock() as never,
    mailer: { send: async () => {} } as never,
    billing: null,
    reportQueue: { add: async () => {} } as never,
    pingDb: async () => true,
    pingRedis: async () => true,
    env: {
      NODE_ENV: 'test', COOKIE_HMAC_KEY: 'k'.repeat(32),
      PUBLIC_BASE_URL: 'http://localhost',
      STRIPE_PRICE_ID: null, STRIPE_WEBHOOK_SECRET: null, STRIPE_CREDITS_PRICE_ID: null,
    },
  })
}

describe('GET /report/:id', () => {
  let testDb: TestDb
  let store: PostgresStore
  let app: Hono

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
    app = buildTestApp(store)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('happy path: valid token + paid report → 200 HTML', async () => {
    const { reportId, token } = await seedPaidReport(store)
    const res = await app.request(`/report/${reportId}?t=${token}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('stripe.com')
    expect(body).toContain('Methodology')
  })

  it('wrong token → 404', async () => {
    const { reportId } = await seedPaidReport(store)
    const res = await app.request(`/report/${reportId}?t=wrongwrong`)
    expect(res.status).toBe(404)
  })

  it('missing token → 404', async () => {
    const { reportId } = await seedPaidReport(store)
    const res = await app.request(`/report/${reportId}`)
    expect(res.status).toBe(404)
  })

  it('nonexistent id → 404', async () => {
    const res = await app.request(`/report/${randomUUID()}?t=whatever`)
    expect(res.status).toBe(404)
  })

  it('unpaid report → 404', async () => {
    const grade = await store.createGrade({
      url: 'https://free.test', domain: 'free.test', tier: 'free',
      cookie: null, userId: null, status: 'done',
    })
    const report = await store.createReport({ gradeId: grade.id, token: 'tok' })
    const res = await app.request(`/report/${report.id}?t=tok`)
    expect(res.status).toBe(404)
  })

  it('invalid UUID in :id → 404', async () => {
    const res = await app.request(`/report/not-a-uuid?t=x`)
    expect(res.status).toBe(404)
  })
})

describe('GET /report/:id.pdf', () => {
  let testDb: TestDb
  let store: PostgresStore
  let app: Hono

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
    app = buildTestApp(store)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('no pdf row → 202 pending', async () => {
    const { reportId, token } = await seedPaidReport(store)
    const res = await app.request(`/report/${reportId}.pdf?t=${token}`)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'pending' })
  })

  it('ready → 200 application/pdf', async () => {
    const { reportId, token } = await seedPaidReport(store)
    await store.initReportPdfRow(reportId)
    await store.writeReportPdf(reportId, Buffer.from('%PDF-test'))
    const res = await app.request(`/report/${reportId}.pdf?t=${token}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.toString()).toBe('%PDF-test')
  })

  it('failed → 503', async () => {
    const { reportId, token } = await seedPaidReport(store)
    await store.initReportPdfRow(reportId)
    await store.setReportPdfStatus(reportId, 'failed', 'test')
    const res = await app.request(`/report/${reportId}.pdf?t=${token}`)
    expect(res.status).toBe(503)
  })
})

describe('GET /report/:id/status', () => {
  let testDb: TestDb
  let store: PostgresStore
  let app: Hono

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
    app = buildTestApp(store)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('returns html=ready, pdf=pending by default', async () => {
    const { reportId, token } = await seedPaidReport(store)
    const res = await app.request(`/report/${reportId}/status?t=${token}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ html: 'ready', pdf: 'pending' })
  })

  it('reflects pdf=ready after worker writes bytes', async () => {
    const { reportId, token } = await seedPaidReport(store)
    await store.initReportPdfRow(reportId)
    await store.writeReportPdf(reportId, Buffer.from('%PDF-test'))
    const res = await app.request(`/report/${reportId}/status?t=${token}`)
    expect(await res.json()).toEqual({ html: 'ready', pdf: 'ready' })
  })
})
