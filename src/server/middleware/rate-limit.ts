import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import { peekBucket, addToBucket, type BucketResult } from './bucket.ts'

const WINDOW_MS = 86_400_000
const ANON_LIMIT = 3
const CREDITS_LIMIT = 10

export type PaywallReason = 'email' | 'daily_cap'

export interface RateLimitResult extends BucketResult {
  paywall: PaywallReason
}

function gradeBucketKey(ip: string, cookie: string): string {
  return `bucket:ip:${ip}+cookie:${cookie}`
}

export async function checkRateLimit(
  redis: Redis,
  store: GradeStore,
  ip: string,
  cookie: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const row = await store.getCookieWithUserAndCredits(cookie)
  const hasCredits = row.credits > 0
  const limit = hasCredits ? CREDITS_LIMIT : ANON_LIMIT
  // hasCredits → 'daily_cap' (already paying customer, just wait it out)
  // otherwise → 'email' (anon or verified-no-credits, paywall is buy credits)
  const paywall: PaywallReason = hasCredits ? 'daily_cap' : 'email'
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  const peek = await peekBucket(redis, cfg, now)
  if (!peek.allowed) return { ...peek, paywall }
  await addToBucket(redis, cfg, now)
  return { allowed: true, limit, used: peek.used + 1, retryAfter: 0, paywall }
}

type Env = { Variables: { clientIp: string; cookie: string } }

export function rateLimitMiddleware(redis: Redis, store: GradeStore): MiddlewareHandler<Env> {
  return async (c, next) => {
    const result = await checkRateLimit(redis, store, c.var.clientIp, c.var.cookie)
    if (!result.allowed) {
      return c.json({
        paywall: result.paywall,
        limit: result.limit,
        used: result.used,
        retryAfter: result.retryAfter,
      }, 429)
    }
    await next()
  }
}
