import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import { peekBucket, addToBucket, removeFromBucket, type BucketResult } from './bucket.ts'

const WINDOW_MS = 86_400_000
const ANON_LIMIT = 3
const CREDITS_LIMIT = 10

export type PaywallReason = 'email' | 'daily_cap'

export interface RateLimitPeekResult extends BucketResult {
  paywall: PaywallReason
}

export function gradeBucketKey(ip: string, cookie: string): string {
  return `bucket:ip:${ip}+cookie:${cookie}`
}

export function gradeBucketMember(gradeId: string): string {
  return `grade:${gradeId}`
}

async function bucketCfg(store: GradeStore, cookie: string): Promise<{ limit: number; paywall: PaywallReason }> {
  const row = await store.getCookieWithUserAndCredits(cookie)
  const hasCredits = row.credits > 0
  return {
    limit: hasCredits ? CREDITS_LIMIT : ANON_LIMIT,
    paywall: hasCredits ? 'daily_cap' : 'email',
  }
}

export async function peekRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, now: number = Date.now(),
): Promise<RateLimitPeekResult> {
  const { limit, paywall } = await bucketCfg(store, cookie)
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  const peek = await peekBucket(redis, cfg, now)
  return { ...peek, paywall }
}

export async function commitRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, gradeId: string, now: number = Date.now(),
): Promise<void> {
  const { limit } = await bucketCfg(store, cookie)
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  await addToBucket(redis, cfg, now, gradeBucketMember(gradeId))
}

export async function refundRateLimit(
  redis: Redis, ip: string, cookie: string, gradeId: string,
): Promise<void> {
  await removeFromBucket(redis, { key: gradeBucketKey(ip, cookie) }, gradeBucketMember(gradeId))
}

type Env = { Variables: { clientIp: string; cookie: string; userId: string | null } }

export function rateLimitMiddleware(redis: Redis, store: GradeStore): MiddlewareHandler<Env> {
  return async (c, next) => {
    const result = await peekRateLimit(redis, store, c.var.clientIp, c.var.cookie)
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
