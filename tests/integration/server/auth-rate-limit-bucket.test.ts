import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import {
  peekMagicEmailBucket, peekMagicIpBucket,
  addMagicEmailBucket, addMagicIpBucket,
} from '../../../src/server/middleware/auth-rate-limit.ts'

let container: StartedTestContainer
let redis: Redis

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
}, 30_000)

afterAll(async () => { await redis.quit(); await container.stop() })
beforeEach(async () => { await redis.flushall() })

describe('auth-rate-limit', () => {
  it('email bucket: limit 1 per 60s', async () => {
    const t = Date.now()
    const r0 = await peekMagicEmailBucket(redis, 'a@b.com', t)
    expect(r0).toEqual({ allowed: true, limit: 1, used: 0, retryAfter: 0 })
    await addMagicEmailBucket(redis, 'a@b.com', t)
    const r1 = await peekMagicEmailBucket(redis, 'a@b.com', t + 1)
    expect(r1.allowed).toBe(false)
    expect(r1.limit).toBe(1)
  })

  it('ip bucket: limit 5 per 10m', async () => {
    const t = Date.now()
    for (let i = 0; i < 5; i++) await addMagicIpBucket(redis, '1.2.3.4', t + i)
    const r = await peekMagicIpBucket(redis, '1.2.3.4', t + 6)
    expect(r.allowed).toBe(false)
    expect(r.limit).toBe(5)
    expect(r.used).toBe(5)
  })

  it('buckets are isolated per-email and per-ip', async () => {
    const t = Date.now()
    await addMagicEmailBucket(redis, 'a@b.com', t)
    const other = await peekMagicEmailBucket(redis, 'c@d.com', t + 1)
    expect(other.allowed).toBe(true)
  })
})
