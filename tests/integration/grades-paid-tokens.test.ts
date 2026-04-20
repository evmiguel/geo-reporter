import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import IORedisMock from 'ioredis-mock'
import { buildApp } from '../../src/server/app.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { signCookie } from '../../src/server/middleware/cookie-sign.ts'
import { COOKIE_NAME } from '../../src/server/middleware/cookie.ts'
import { startTestDb, type TestDb } from './setup.ts'

const HMAC_KEY = 'k'.repeat(32)

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
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: HMAC_KEY,
      PUBLIC_BASE_URL: 'http://localhost',
      STRIPE_PRICE_ID: null,
      STRIPE_WEBHOOK_SECRET: null,
      STRIPE_CREDITS_PRICE_ID: null,
    },
  })
}

describe('GET /grades/:id paid-tier fields', () => {
  let testDb: TestDb
  let store: PostgresStore
  let app: Hono

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
    app = buildTestApp(store)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('omits reportId/reportToken for free tier', async () => {
    const cookieUuid = randomUUID()
    await store.upsertCookie(cookieUuid)
    const grade = await store.createGrade({
      url: 'https://a.test',
      domain: 'a.test',
      tier: 'free',
      cookie: cookieUuid,
      userId: null,
      status: 'done',
    })
    const signed = signCookie(cookieUuid, HMAC_KEY)
    const res = await app.request(`/grades/${grade.id}`, {
      headers: { cookie: `${COOKIE_NAME}=${signed}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.id).toBe(grade.id)
    expect(body.tier).toBe('free')
    expect(body.reportId).toBeUndefined()
    expect(body.reportToken).toBeUndefined()
  })

  it('includes reportId + reportToken for paid tier', async () => {
    const cookieUuid = randomUUID()
    await store.upsertCookie(cookieUuid)
    const grade = await store.createGrade({
      url: 'https://b.test',
      domain: 'b.test',
      tier: 'paid',
      cookie: cookieUuid,
      userId: null,
      status: 'done',
    })
    const token = 'tok-'.repeat(16)
    const report = await store.createReport({ gradeId: grade.id, token })
    const signed = signCookie(cookieUuid, HMAC_KEY)
    const res = await app.request(`/grades/${grade.id}`, {
      headers: { cookie: `${COOKIE_NAME}=${signed}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.tier).toBe('paid')
    expect(body.reportId).toBe(report.id)
    expect(body.reportToken).toBe(token)
  })

  it('omits reportId/reportToken for paid tier when report row missing', async () => {
    const cookieUuid = randomUUID()
    await store.upsertCookie(cookieUuid)
    const grade = await store.createGrade({
      url: 'https://c.test',
      domain: 'c.test',
      tier: 'paid',
      cookie: cookieUuid,
      userId: null,
      status: 'done',
    })
    const signed = signCookie(cookieUuid, HMAC_KEY)
    const res = await app.request(`/grades/${grade.id}`, {
      headers: { cookie: `${COOKIE_NAME}=${signed}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.tier).toBe('paid')
    expect(body.reportId).toBeUndefined()
    expect(body.reportToken).toBeUndefined()
  })
})
