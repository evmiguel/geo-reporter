import { describe, expect, it } from 'vitest'
import { peekRateLimit, commitRateLimit, refundRateLimit } from '../../../../src/server/middleware/rate-limit.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import type { GradeStore } from '../../../../src/store/types.ts'
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
    async zrem(key: string, member: string): Promise<number> {
      const arr = zsets.get(key) ?? []
      const kept = arr.filter((e) => e.member !== member)
      zsets.set(key, kept)
      return arr.length - kept.length
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

// Helper that captures the pre-Plan-12 peek-then-commit behavior atomically for
// tests that don't care about the split. Each call commits a fresh synthetic
// gradeId so the bucket behaves exactly as checkRateLimit used to.
let __gradeCounter = 0
async function simulateGrade(
  redis: Redis, store: GradeStore, ip: string, cookie: string, now?: number,
): Promise<{ allowed: boolean; limit: number; used: number; retryAfter: number; paywall: 'email' | 'daily_cap' }> {
  const peek = await peekRateLimit(redis, store, ip, cookie, now)
  if (!peek.allowed) return peek
  const gradeId = `g-${++__gradeCounter}`
  await commitRateLimit(redis, store, ip, cookie, gradeId, now)
  return { ...peek, used: peek.used + 1 }
}

const now = 1_700_000_000_000   // fixed ms epoch for determinism

describe('peekRateLimit + commitRateLimit', () => {
  it('allows the first request for an anonymous cookie', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const redis = makeStubRedis()
    const result = await simulateGrade(redis, store, '203.0.113.1', 'c-1', now)
    expect(result).toEqual({ allowed: true, limit: 3, used: 1, retryAfter: 0, paywall: 'email' })
  })

  it('blocks the 4th anonymous request within 24h with retryAfter = age-until-oldest-expires', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-2')
    const redis = makeStubRedis()
    await simulateGrade(redis, store, '203.0.113.2', 'c-2', now)
    await simulateGrade(redis, store, '203.0.113.2', 'c-2', now + 1000)
    await simulateGrade(redis, store, '203.0.113.2', 'c-2', now + 2000)
    const fourth = await simulateGrade(redis, store, '203.0.113.2', 'c-2', now + 3000)
    expect(fourth.allowed).toBe(false)
    expect(fourth.limit).toBe(3)
    expect(fourth.used).toBe(3)
    expect(fourth.retryAfter).toBe(86397)
  })

  it('allows the 4th request after the oldest entry falls out of the 24h window', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-3')
    const redis = makeStubRedis()
    await simulateGrade(redis, store, '203.0.113.3', 'c-3', now)
    await simulateGrade(redis, store, '203.0.113.3', 'c-3', now + 1000)
    await simulateGrade(redis, store, '203.0.113.3', 'c-3', now + 2000)
    const later = now + 86_401_000
    const result = await simulateGrade(redis, store, '203.0.113.3', 'c-3', later)
    expect(result.allowed).toBe(true)
    expect(result.used).toBe(3)
  })

  it('verified cookie (no credits) gets limit 3 (same as anonymous)', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('verified@example.com')
    const cookie = 'c-4'
    await store.upsertCookie(cookie, user.id)
    const redis = makeStubRedis()
    const ip = '203.0.113.4'
    for (let i = 0; i < 3; i++) {
      const r = await simulateGrade(redis, store, ip, cookie, now + i * 1000)
      expect(r.allowed).toBe(true)
      expect(r.limit).toBe(3)
    }
    const blocked = await simulateGrade(redis, store, ip, cookie, now + 3000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(3)
  })

  it('credit-holding cookie gets limit 10', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    const cookie = 'verified-with-credits'
    await store.upsertCookie(cookie, user.id)
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_rl', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_rl', user.id, 10, 2900, 'usd')
    const redis = makeStubRedis()

    const ip = '203.0.113.5'
    for (let i = 0; i < 10; i++) {
      const r = await simulateGrade(redis, store, ip, cookie, now + i * 1000)
      expect(r.allowed).toBe(true)
      expect(r.limit).toBe(10)
    }
    const blocked = await simulateGrade(redis, store, ip, cookie, now + 10_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(10)
  })

  it('treats the same cookie from different IPs as independent buckets', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-6')
    const redis = makeStubRedis()
    for (let i = 0; i < 3; i++) {
      const r = await simulateGrade(redis, store, '203.0.113.6', 'c-6', now + i)
      expect(r.allowed).toBe(true)
    }
    const blocked = await simulateGrade(redis, store, '203.0.113.6', 'c-6', now + 4)
    expect(blocked.allowed).toBe(false)
    const fresh = await simulateGrade(redis, store, '203.0.113.77', 'c-6', now + 5)
    expect(fresh.allowed).toBe(true)
    expect(fresh.used).toBe(1)
  })

  it('sets a 24h expire on the bucket key', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-7')
    const redis = makeStubRedis()
    await simulateGrade(redis, store, '203.0.113.7', 'c-7', now)
    // @ts-expect-error — accessing stub debug
    const ttls = (redis as { __debug: { ttls: Map<string, number> } }).__debug.ttls
    expect(ttls.get('bucket:ip:203.0.113.7+cookie:c-7')).toBe(86400)
  })

  it("blocked anon hit returns paywall='email'", async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-paywall-anon')
    const redis = makeStubRedis()
    for (let i = 0; i < 3; i++) {
      await simulateGrade(redis, store, '203.0.113.20', 'c-paywall-anon', now + i)
    }
    const blocked = await simulateGrade(redis, store, '203.0.113.20', 'c-paywall-anon', now + 4)
    expect(blocked.allowed).toBe(false)
    expect(blocked.paywall).toBe('email')
  })

  it("blocked credit-holder hit returns paywall='daily_cap'", async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('cap@x.com')
    const cookie = 'c-paywall-credits'
    await store.upsertCookie(cookie, user.id)
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_cap', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_cap', user.id, 10, 2900, 'usd')
    const redis = makeStubRedis()
    for (let i = 0; i < 10; i++) {
      await simulateGrade(redis, store, '203.0.113.21', cookie, now + i)
    }
    const blocked = await simulateGrade(redis, store, '203.0.113.21', cookie, now + 11)
    expect(blocked.allowed).toBe(false)
    expect(blocked.paywall).toBe('daily_cap')
  })

  it('treats an unknown cookie (no DB row) as anonymous limit=3', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const result = await simulateGrade(redis, store, '203.0.113.8', 'c-unknown', now)
    expect(result.limit).toBe(3)
    expect(result.allowed).toBe(true)
  })

  it('refundRateLimit removes the grade-specific bucket entry', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-refund')
    const redis = makeStubRedis()
    const ip = '203.0.113.30'
    await commitRateLimit(redis, store, ip, 'c-refund', 'grade-a', now)
    await commitRateLimit(redis, store, ip, 'c-refund', 'grade-b', now + 1)
    await commitRateLimit(redis, store, ip, 'c-refund', 'grade-c', now + 2)

    // Fourth request should be blocked.
    const blocked = await peekRateLimit(redis, store, ip, 'c-refund', now + 3)
    expect(blocked.allowed).toBe(false)

    // Refund grade-b; now used drops to 2 and a new request is allowed.
    await refundRateLimit(redis, ip, 'c-refund', 'grade-b')
    const after = await peekRateLimit(redis, store, ip, 'c-refund', now + 4)
    expect(after.allowed).toBe(true)
    expect(after.used).toBe(2)
  })
})
