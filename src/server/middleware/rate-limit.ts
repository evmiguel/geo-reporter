import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import { peekBucket, addToBucket, type BucketResult } from './bucket.ts'

const WINDOW_MS = 86_400_000
const ANON_LIMIT = 3
const VERIFIED_LIMIT = 13

function gradeBucketKey(ip: string, cookie: string): string {
  return `bucket:ip:${ip}+cookie:${cookie}`
}

export async function checkRateLimit(
  redis: Redis,
  store: GradeStore,
  ip: string,
  cookie: string,
  now: number = Date.now(),
): Promise<BucketResult> {
  const row = await store.getCookie(cookie)
  const limit = row?.userId ? VERIFIED_LIMIT : ANON_LIMIT
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  const peek = await peekBucket(redis, cfg, now)
  if (!peek.allowed) return peek
  await addToBucket(redis, cfg, now)
  return { allowed: true, limit, used: peek.used + 1, retryAfter: 0 }
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
