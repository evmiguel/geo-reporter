import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import { peekBucket, addToBucket, removeFromBucket, type BucketResult } from './bucket.ts'

const WINDOW_MS = 86_400_000
const ANON_LIMIT = 2
const CREDITS_LIMIT = 10
/**
 * Per-IP daily ceiling for anonymous callers — prevents incognito abuse
 * where the cookie resets per private window. Verified users (userId !== null)
 * skip this check entirely; identity is their rate-limit signal.
 */
const ANON_IP_CEILING = 5

export type PaywallReason = 'email' | 'daily_cap' | 'ip_exhausted'

export interface RateLimitPeekResult extends BucketResult {
  paywall: PaywallReason
}

export function gradeBucketKey(ip: string, cookie: string): string {
  return `bucket:ip:${ip}+cookie:${cookie}`
}

export function gradeBucketMember(gradeId: string): string {
  return `grade:${gradeId}`
}

export function anonIpBucketKey(ip: string): string {
  return `bucket:ip-anon:${ip}`
}

async function bucketCfg(store: GradeStore, cookie: string): Promise<{
  limit: number
  paywall: PaywallReason
  isAnonymous: boolean
}> {
  const row = await store.getCookieWithUserAndCredits(cookie)
  const hasCredits = row.credits > 0
  const isAnonymous = row.userId === null
  return {
    limit: hasCredits ? CREDITS_LIMIT : ANON_LIMIT,
    paywall: hasCredits ? 'daily_cap' : 'email',
    isAnonymous,
  }
}

export async function peekRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, now: number = Date.now(),
): Promise<RateLimitPeekResult> {
  const { limit, paywall, isAnonymous } = await bucketCfg(store, cookie)

  // Anonymous callers hit the per-IP ceiling first — if it's maxed, no further
  // check needed. This is the defense against incognito abuse: a user opening
  // 5 private windows gets 5 total grades per IP, not 5 × 3.
  if (isAnonymous) {
    const ipCfg = { key: anonIpBucketKey(ip), limit: ANON_IP_CEILING, windowMs: WINDOW_MS }
    const ipPeek = await peekBucket(redis, ipCfg, now)
    if (!ipPeek.allowed) {
      return { ...ipPeek, paywall: 'ip_exhausted' }
    }
  }

  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  const peek = await peekBucket(redis, cfg, now)
  return { ...peek, paywall }
}

export async function commitRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, gradeId: string, now: number = Date.now(),
): Promise<void> {
  const { limit, isAnonymous } = await bucketCfg(store, cookie)
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  await addToBucket(redis, cfg, now, gradeBucketMember(gradeId))

  // Anonymous grades also increment the per-IP ceiling. Verified users are
  // exempt — their identity already caps their usage via the cookie bucket.
  if (isAnonymous) {
    const ipCfg = { key: anonIpBucketKey(ip), limit: ANON_IP_CEILING, windowMs: WINDOW_MS }
    await addToBucket(redis, ipCfg, now, gradeBucketMember(gradeId))
  }
}

export async function refundRateLimit(
  redis: Redis, ip: string, cookie: string, gradeId: string,
): Promise<void> {
  // Refund from both buckets. zrem of a non-existent member is a no-op, so
  // refunding the anon-IP bucket for a verified grade is harmless — we don't
  // need to thread the anonymity flag through the worker.
  const member = gradeBucketMember(gradeId)
  await removeFromBucket(redis, { key: gradeBucketKey(ip, cookie) }, member)
  await removeFromBucket(redis, { key: anonIpBucketKey(ip) }, member)
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
