import { describe, expect, it } from 'vitest'
import { checkRateLimit } from '../../../../src/server/middleware/rate-limit.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import type Redis from 'ioredis'

// Stub Redis supporting sorted-set operations + ttl.
function makeStubRedis(): Redis {
  const zsets = new Map<string, { score: number; member: string }[]>()
  const ttls = new Map<string, number>()
  const stub = {
    async zadd(key: string, score: number, member: string): Promise<number> {
      const arr = zsets.get(key) ?? []
      arr.push({ score, member })
      zsets.set(key, arr)
      return 1
    },
    async zcard(key: string): Promise<number> { return (zsets.get(key) ?? []).length },
    async zremrangebyscore(key: string, _min: string, max: string): Promise<number> {
      const arr = zsets.get(key) ?? []
      const cutoff = Number(max)
      const kept = arr.filter((e) => e.score > cutoff)
      zsets.set(key, kept)
      return arr.length - kept.length
    },
    async zrange(key: string, start: number, stop: number, _withscores?: string): Promise<string[]> {
      const arr = [...(zsets.get(key) ?? [])].sort((a, b) => a.score - b.score)
      const slice = arr.slice(start, stop + 1)
      // WITHSCORES format: [member, score, member, score, ...]
      const flat: string[] = []
      for (const e of slice) { flat.push(e.member, String(e.score)) }
      return flat
    },
    async expire(key: string, seconds: number): Promise<number> {
      ttls.set(key, seconds)
      return 1
    },
    __debug: { zsets, ttls },
  }
  return stub as unknown as Redis
}

const now = 1_700_000_000_000   // fixed ms epoch for determinism

describe('checkRateLimit', () => {
  it('allows the first request for an anonymous cookie', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const redis = makeStubRedis()
    const result = await checkRateLimit(redis, store, '203.0.113.1', 'c-1', now)
    expect(result).toEqual({ allowed: true, limit: 3, used: 1, retryAfter: 0 })
  })

  it('blocks the 4th anonymous request within 24h with retryAfter = age-until-oldest-expires', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-2')
    const redis = makeStubRedis()
    await checkRateLimit(redis, store, '203.0.113.2', 'c-2', now)
    await checkRateLimit(redis, store, '203.0.113.2', 'c-2', now + 1000)
    await checkRateLimit(redis, store, '203.0.113.2', 'c-2', now + 2000)
    const fourth = await checkRateLimit(redis, store, '203.0.113.2', 'c-2', now + 3000)
    expect(fourth.allowed).toBe(false)
    expect(fourth.limit).toBe(3)
    expect(fourth.used).toBe(3)
    // Oldest entry was at `now`; fourth checked at `now + 3000ms`.
    // Window is 86400000ms; oldest expires at `now + 86400000`.
    // retryAfter = ceil((now + 86400000 - (now + 3000)) / 1000) = ceil(86397) = 86397
    expect(fourth.retryAfter).toBe(86397)
  })

  it('allows the 4th request after the oldest entry falls out of the 24h window', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-3')
    const redis = makeStubRedis()
    await checkRateLimit(redis, store, '203.0.113.3', 'c-3', now)
    await checkRateLimit(redis, store, '203.0.113.3', 'c-3', now + 1000)
    await checkRateLimit(redis, store, '203.0.113.3', 'c-3', now + 2000)
    // Now jump 24h + 1s — the oldest entry at `now` falls out.
    const later = now + 86_401_000
    const result = await checkRateLimit(redis, store, '203.0.113.3', 'c-3', later)
    expect(result.allowed).toBe(true)
    // After ZREMRANGEBYSCORE drops the oldest, 2 remain in-window; this becomes the 3rd.
    expect(result.used).toBe(3)
  })

  it('gives email-verified cookies limit=13', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('verified@example.com')
    await store.upsertCookie('c-4', user.id)
    const redis = makeStubRedis()
    const result = await checkRateLimit(redis, store, '203.0.113.4', 'c-4', now)
    expect(result.allowed).toBe(true)
    expect(result.limit).toBe(13)
  })

  it('blocks the 14th verified request', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('heavy@example.com')
    await store.upsertCookie('c-5', user.id)
    const redis = makeStubRedis()
    for (let i = 0; i < 13; i++) {
      await checkRateLimit(redis, store, '203.0.113.5', 'c-5', now + i * 1000)
    }
    const fourteenth = await checkRateLimit(redis, store, '203.0.113.5', 'c-5', now + 13_000)
    expect(fourteenth.allowed).toBe(false)
    expect(fourteenth.limit).toBe(13)
    expect(fourteenth.used).toBe(13)
  })

  it('treats the same cookie from different IPs as independent buckets', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-6')
    const redis = makeStubRedis()
    // 3 from IP A
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(redis, store, '203.0.113.6', 'c-6', now + i)
      expect(r.allowed).toBe(true)
    }
    // A 4th from IP A is blocked
    const blocked = await checkRateLimit(redis, store, '203.0.113.6', 'c-6', now + 4)
    expect(blocked.allowed).toBe(false)
    // But the same cookie from IP B starts fresh
    const fresh = await checkRateLimit(redis, store, '203.0.113.77', 'c-6', now + 5)
    expect(fresh.allowed).toBe(true)
    expect(fresh.used).toBe(1)
  })

  it('sets a 24h expire on the bucket key', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-7')
    const redis = makeStubRedis()
    await checkRateLimit(redis, store, '203.0.113.7', 'c-7', now)
    // @ts-expect-error — accessing stub debug
    const ttls = (redis as { __debug: { ttls: Map<string, number> } }).__debug.ttls
    expect(ttls.get('bucket:ip:203.0.113.7+cookie:c-7')).toBe(86400)
  })

  it('treats an unknown cookie (no DB row) as anonymous limit=3', async () => {
    const store = makeFakeStore()
    // Deliberately do NOT upsertCookie — cookie middleware ensures row exists
    // in production, but checkRateLimit must be defensive.
    const redis = makeStubRedis()
    const result = await checkRateLimit(redis, store, '203.0.113.8', 'c-unknown', now)
    expect(result.limit).toBe(3)
    expect(result.allowed).toBe(true)
  })
})
