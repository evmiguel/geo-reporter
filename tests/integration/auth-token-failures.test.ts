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
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

async function issueCookie(app: ReturnType<typeof buildHarnessApp>): Promise<string> {
  const res = await app.fetch(new Request('http://test/auth/me'))
  return extractCookie(res)
}

async function requestMagicLink(app: ReturnType<typeof buildHarnessApp>, cookie: string, email: string): Promise<string> {
  await app.fetch(new Request('http://test/auth/magic', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify({ email }),
  }))
  const url = new URL(mailer.sent.at(-1)!.url)
  return url.searchParams.get('t')!
}

describe('magic-link integration — failures', () => {
  it('expired token redirects to auth_error', async () => {
    const app = buildHarnessApp()
    const cookie = await issueCookie(app)
    const token = await requestMagicLink(app, cookie, 'user@example.com')

    // Force-expire in DB
    await testDb.db.execute(sql`UPDATE magic_tokens SET expires_at = now() - interval '1 minute'`)

    const res = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  }, 30_000)

  it('double-consume redirects second attempt to auth_error', async () => {
    const app = buildHarnessApp()
    const cookie = await issueCookie(app)
    const token = await requestMagicLink(app, cookie, 'user@example.com')

    const first = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(first.headers.get('location')).toBe('/?verified=1')

    const second = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(second.status).toBe(302)
    expect(second.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  }, 30_000)
})
