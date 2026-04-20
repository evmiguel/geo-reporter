import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { sql } from 'drizzle-orm'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { buildApp } from '../../src/server/app.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { startTestDb, type TestDb } from './setup.ts'
import type Redis from 'ioredis'
import type { Queue } from 'bullmq'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb
let redis: Redis
let mailer: FakeMailer

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
  await testDb.db.execute(sql`TRUNCATE grades, scrapes, probes, recommendations, reports, stripe_payments, magic_tokens, cookies, users RESTART IDENTITY CASCADE`)
  if (redis) await redis.quit()
  redis = createRedis(redisUrl)
  await redis.flushall()
  mailer = new FakeMailer()
})

function buildHarnessApp() {
  return buildApp({
    store: new PostgresStore(testDb.db),
    redis,
    redisFactory: () => createRedis(redisUrl),
    mailer,
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
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const raw = setCookie.split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('magic-link integration — full flow', () => {
  it('magic-link verify binds user to cookie; rate limit stays at 3 without credits', async () => {
    const app = buildHarnessApp()

    // Bootstrap: hit /auth/me with no cookie to get one issued
    const bootstrap = await app.fetch(new Request('http://test/auth/me'))
    const cookie = extractCookie(bootstrap)

    // 3 anonymous grades pass
    for (let i = 0; i < 3; i++) {
      const r = await app.fetch(new Request('http://test/grades', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
        body: JSON.stringify({ url: `https://example.com/p${i}` }),
      }))
      expect(r.status).toBe(202)
    }

    // 4th should be 429 (anon limit 3)
    const fourth = await app.fetch(new Request('http://test/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ url: 'https://example.com/p4' }),
    }))
    expect(fourth.status).toBe(429)

    // Request magic link
    const magicRes = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'user@example.com' }),
    }))
    expect(magicRes.status).toBe(204)
    expect(mailer.sent).toHaveLength(1)

    // Pluck token and verify
    const token = new URL(mailer.sent[0]!.url).searchParams.get('t')!
    const verifyRes = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(verifyRes.status).toBe(302)
    expect(verifyRes.headers.get('location')).toBe('/?verified=1')

    // Credits Pack design: verify alone does not lift the rate limit.
    // Anon and verified (no credits) both get 3/24h; only users with credits get 10/24h.
    const retried = await app.fetch(new Request('http://test/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ url: 'https://example.com/p4' }),
    }))
    expect(retried.status).toBe(429)
  }, 60_000)

  it('preserve-intent: magic-link verify honors `next` query param', async () => {
    const app = buildHarnessApp()
    const bootstrap = await app.fetch(new Request('http://test/auth/me'))
    const cookie = extractCookie(bootstrap)

    // Request magic link with `next` pointing back at a grade page
    const magicRes = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'user2@example.com', next: '/g/abc123' }),
    }))
    expect(magicRes.status).toBe(204)
    const magicUrl = new URL(mailer.sent[0]!.url)
    expect(magicUrl.searchParams.get('next')).toBe('/g/abc123')

    const token = magicUrl.searchParams.get('t')!
    const verifyRes = await app.fetch(new Request(`http://test/auth/verify?t=${token}&next=/g/abc123`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(verifyRes.status).toBe(302)
    expect(verifyRes.headers.get('location')).toBe('/g/abc123?verified=1')
  }, 60_000)

  it('rejects malformed `next` (open redirect protection)', async () => {
    const app = buildHarnessApp()
    const bootstrap = await app.fetch(new Request('http://test/auth/me'))
    const cookie = extractCookie(bootstrap)

    // Schema validation rejects protocol-relative URLs at /auth/magic
    const magicRes = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'user3@example.com', next: '//evil.com' }),
    }))
    expect(magicRes.status).toBe(400)
  }, 60_000)
})
