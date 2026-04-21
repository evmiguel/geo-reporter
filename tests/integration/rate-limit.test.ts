import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import {
  peekRateLimit,
  commitRateLimit,
  refundRateLimit,
} from '../../src/server/middleware/rate-limit.ts'
import type Redis from 'ioredis'
import type { GradeStore } from '../../src/store/types.ts'
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

// Peek-then-commit helper that reproduces the pre-Plan-12 atomic behavior.
let __gradeCounter = 0
async function simulateGrade(redis: Redis, store: GradeStore, ip: string, cookie: string) {
  const peek = await peekRateLimit(redis, store, ip, cookie)
  if (!peek.allowed) return peek
  await commitRateLimit(redis, store, ip, cookie, `int-${++__gradeCounter}`)
  return { ...peek, used: peek.used + 1 }
}

describe('rate-limit (integration)', () => {
  it('allows 3 anonymous requests, blocks the 4th', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const cookie = `anon-${Date.now()}`
    await store.upsertCookie(cookie)

    const ip = '203.0.113.100'
    for (let i = 0; i < 2; i++) {
      const r = await simulateGrade(redis, store, ip, cookie)
      expect(r.allowed).toBe(true)
    }
    const blocked = await simulateGrade(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(2)
    expect(blocked.retryAfter).toBeGreaterThan(0)

    await redis.quit()
  })

  it('verified cookies (userId set, no credits) get limit=2', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const user = await store.upsertUser(`rl-${Date.now()}@example.com`)
    const cookie = `verified-${Date.now()}`
    await store.upsertCookie(cookie, user.id)

    const ip = '203.0.113.101'
    for (let i = 0; i < 2; i++) {
      const r = await simulateGrade(redis, store, ip, cookie)
      expect(r.allowed).toBe(true)
      expect(r.limit).toBe(2)
    }
    const blocked = await simulateGrade(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(2)

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
      const r = await simulateGrade(redis, store, ip, cookie)
      expect(r.allowed).toBe(true)
      expect(r.limit).toBe(10)
    }
    const blocked = await simulateGrade(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(10)
    await redis.quit()
  })

  it('different IP + same cookie gets an independent bucket', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const cookie = `shared-${Date.now()}`
    await store.upsertCookie(cookie)

    for (let i = 0; i < 2; i++) {
      await simulateGrade(redis, store, '203.0.113.200', cookie)
    }
    const blocked = await simulateGrade(redis, store, '203.0.113.200', cookie)
    expect(blocked.allowed).toBe(false)

    const fresh = await simulateGrade(redis, store, '203.0.113.201', cookie)
    expect(fresh.allowed).toBe(true)
    expect(fresh.used).toBe(1)

    await redis.quit()
  })

  it('refundRateLimit removes the named member so a new grade is allowed', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const cookie = `refund-${Date.now()}`
    await store.upsertCookie(cookie)

    const ip = '203.0.113.250'
    await commitRateLimit(redis, store, ip, cookie, 'g-one')
    await commitRateLimit(redis, store, ip, cookie, 'g-two')
    await commitRateLimit(redis, store, ip, cookie, 'g-three')

    const blocked = await peekRateLimit(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)

    await refundRateLimit(redis, ip, cookie, 'g-two')
    const after = await peekRateLimit(redis, store, ip, cookie)
    expect(after.allowed).toBe(true)
    expect(after.used).toBe(2)

    await redis.quit()
  })
})
