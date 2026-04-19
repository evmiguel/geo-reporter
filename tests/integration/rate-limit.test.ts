import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { checkRateLimit } from '../../src/server/middleware/rate-limit.ts'
import { startTestDb, type TestDb } from './setup.ts'

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

describe('rate-limit (integration)', () => {
  it('allows 3 anonymous requests, blocks the 4th', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const cookie = `anon-${Date.now()}`
    await store.upsertCookie(cookie)

    const ip = '203.0.113.100'
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(redis, store, ip, cookie)
      expect(r.allowed).toBe(true)
    }
    const blocked = await checkRateLimit(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(3)
    expect(blocked.retryAfter).toBeGreaterThan(0)

    await redis.quit()
  })

  it('verified cookies (userId set, no credits) get limit=3', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const user = await store.upsertUser(`rl-${Date.now()}@example.com`)
    const cookie = `verified-${Date.now()}`
    await store.upsertCookie(cookie, user.id)

    const ip = '203.0.113.101'
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(redis, store, ip, cookie)
      expect(r.allowed).toBe(true)
      expect(r.limit).toBe(3)
    }
    const blocked = await checkRateLimit(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(3)

    await redis.quit()
  })

  it('credit-holding cookies get limit=10', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const user = await store.upsertUser(`rl-credits-${Date.now()}@example.com`)
    const cookie = `credits-${Date.now()}`
    await store.upsertCookie(cookie, user.id)
    const sessionId = crypto.randomUUID()
    await store.createStripePayment({
      gradeId: null, sessionId, amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid(sessionId, user.id, 10, 2900, 'usd')

    const ip = '203.0.113.102'
    for (let i = 0; i < 10; i++) {
      const r = await checkRateLimit(redis, store, ip, cookie)
      expect(r.allowed).toBe(true)
      expect(r.limit).toBe(10)
    }
    const blocked = await checkRateLimit(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(10)
    await redis.quit()
  })

  it('different IP + same cookie gets an independent bucket', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const cookie = `shared-${Date.now()}`
    await store.upsertCookie(cookie)

    for (let i = 0; i < 3; i++) {
      await checkRateLimit(redis, store, '203.0.113.200', cookie)
    }
    const blocked = await checkRateLimit(redis, store, '203.0.113.200', cookie)
    expect(blocked.allowed).toBe(false)

    const fresh = await checkRateLimit(redis, store, '203.0.113.201', cookie)
    expect(fresh.allowed).toBe(true)
    expect(fresh.used).toBe(1)

    await redis.quit()
  })
})
