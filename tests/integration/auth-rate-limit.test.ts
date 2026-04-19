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
    },
  })
}

async function issueCookie(app: ReturnType<typeof buildHarnessApp>): Promise<string> {
  const res = await app.fetch(new Request('http://test/auth/me'))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('magic-link integration — rate limits', () => {
  it('per-email bucket: 2nd request within 60s returns 429 email_cooldown', async () => {
    const app = buildHarnessApp()
    const cookie = await issueCookie(app)

    const first = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'a@b.com' }),
    }))
    expect(first.status).toBe(204)

    const second = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'a@b.com' }),
    }))
    expect(second.status).toBe(429)
    const body = await second.json() as { paywall: string; limit: number }
    expect(body.paywall).toBe('email_cooldown')
    expect(body.limit).toBe(1)
  }, 30_000)

  it('per-ip bucket: 6 different emails from same IP → 6th returns 429 ip_cooldown', async () => {
    const app = buildHarnessApp()
    const cookie = await issueCookie(app)

    for (let i = 0; i < 5; i++) {
      const r = await app.fetch(new Request('http://test/auth/magic', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
        body: JSON.stringify({ email: `u${i}@b.com` }),
      }))
      expect(r.status).toBe(204)
    }

    const sixth = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'u5@b.com' }),
    }))
    expect(sixth.status).toBe(429)
    const body = await sixth.json() as { paywall: string; limit: number }
    expect(body.paywall).toBe('ip_cooldown')
    expect(body.limit).toBe(5)
  }, 30_000)
})
