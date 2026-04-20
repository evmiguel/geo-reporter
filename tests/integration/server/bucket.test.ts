import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import { peekBucket, addToBucket } from '../../../src/server/middleware/bucket.ts'

let redisContainer: StartedTestContainer
let redis: Redis

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redis = new Redis({ host: redisContainer.getHost(), port: redisContainer.getMappedPort(6379) })
}, 30_000)

afterAll(async () => {
  await redis.quit()
  await redisContainer.stop()
})

beforeEach(async () => {
  await redis.flushall()
})

describe('bucket', () => {
  const cfg = { key: 'test:bucket:a', limit: 3, windowMs: 10_000 }

  it('peek returns allowed=true on empty bucket', async () => {
    const r = await peekBucket(redis, cfg, Date.now())
    expect(r).toEqual({ allowed: true, limit: 3, used: 0, retryAfter: 0 })
  })

  it('add increments; peek reflects usage', async () => {
    const t = Date.now()
    await addToBucket(redis, cfg, t, `m:${crypto.randomUUID()}`)
    await addToBucket(redis, cfg, t + 1, `m:${crypto.randomUUID()}`)
    const r = await peekBucket(redis, cfg, t + 2)
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(2)
  })

  it('peek returns allowed=false when at limit', async () => {
    const t = Date.now()
    await addToBucket(redis, cfg, t, `m:${crypto.randomUUID()}`)
    await addToBucket(redis, cfg, t + 1, `m:${crypto.randomUUID()}`)
    await addToBucket(redis, cfg, t + 2, `m:${crypto.randomUUID()}`)
    const r = await peekBucket(redis, cfg, t + 3)
    expect(r.allowed).toBe(false)
    expect(r.used).toBe(3)
    expect(r.retryAfter).toBeGreaterThan(0)
    expect(r.retryAfter).toBeLessThanOrEqual(10)
  })

  it('peek returns allowed=true after window rolls forward', async () => {
    const t0 = Date.now()
    await addToBucket(redis, cfg, t0, `m:${crypto.randomUUID()}`)
    await addToBucket(redis, cfg, t0 + 1, `m:${crypto.randomUUID()}`)
    await addToBucket(redis, cfg, t0 + 2, `m:${crypto.randomUUID()}`)
    // Advance past all three entries' window expiry. The half-open window is
    // (cutoff, now]; ZREMRANGEBYSCORE removes scores strictly less than cutoff.
    // At t0 + 10_003, cutoff = t0 + 3 so entries at t0, t0+1, t0+2 all drop.
    const r = await peekBucket(redis, cfg, t0 + 10_003)
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(0)
  })

  it('entries exactly at cutoff remain inside the window', async () => {
    const cfgShort = { key: 'test:bucket:b', limit: 1, windowMs: 100 }
    const t0 = Date.now()
    await addToBucket(redis, cfgShort, t0, `m:${crypto.randomUUID()}`)
    const r = await peekBucket(redis, cfgShort, t0 + 100)
    expect(r.used).toBe(1)
    expect(r.allowed).toBe(false)
  })
})
