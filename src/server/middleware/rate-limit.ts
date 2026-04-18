import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'

const WINDOW_MS = 86_400_000   // 24h
const EXPIRE_SECONDS = 86_400

const ANON_LIMIT = 3
const VERIFIED_LIMIT = 13

export interface RateLimitResult {
  allowed: boolean
  limit: number
  used: number
  retryAfter: number
}

function bucketKey(ip: string, cookie: string): string {
  return `bucket:ip:${ip}+cookie:${cookie}`
}

export async function checkRateLimit(
  redis: Redis,
  store: GradeStore,
  ip: string,
  cookie: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const row = await store.getCookie(cookie)
  const limit = row?.userId ? VERIFIED_LIMIT : ANON_LIMIT
  const key = bucketKey(ip, cookie)
  const cutoff = now - WINDOW_MS

  await redis.zremrangebyscore(key, '-inf', String(cutoff - 1))
  const used = await redis.zcard(key)

  if (used >= limit) {
    const range = await redis.zrange(key, 0, 0, 'WITHSCORES')
    const oldestScore = range.length >= 2 ? Number(range[1]) : now
    const retryAfter = Math.ceil((oldestScore + WINDOW_MS - now) / 1000)
    return { allowed: false, limit, used, retryAfter }
  }

  await redis.zadd(key, now, `${now}-${crypto.randomUUID()}`)
  await redis.expire(key, EXPIRE_SECONDS)
  return { allowed: true, limit, used: used + 1, retryAfter: 0 }
}

type Env = { Variables: { clientIp: string; cookie: string } }

export function rateLimitMiddleware(redis: Redis, store: GradeStore): MiddlewareHandler<Env> {
  return async (c, next) => {
    const result = await checkRateLimit(redis, store, c.var.clientIp, c.var.cookie)
    if (!result.allowed) {
      return c.json({
        paywall: 'email' as const,
        limit: result.limit,
        used: result.used,
        retryAfter: result.retryAfter,
      }, 429)
    }
    await next()
  }
}
