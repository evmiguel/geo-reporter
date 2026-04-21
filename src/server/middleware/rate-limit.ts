import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import { peekBucket, addToBucket, removeFromBucket, type BucketResult } from './bucket.ts'

const WINDOW_MS = 86_400_000
// Universal free-tier cap. Applied to every caller regardless of credit
// balance. Credit-holders can BYPASS it by spending a credit via
// /grades/redeem — see the "Grade (1 credit)" UX. Making credits an
// overflow mechanic (rather than a raised free-cap) keeps the product
// model simple: "2 free a day; credits buy extras."
const DAILY_LIMIT = 2
/**
 * Per-IP daily ceiling for anonymous callers — prevents incognito abuse
 * where the cookie resets per private window. Verified users (userId !== null)
 * skip this check because they now have a dedicated per-user bucket instead.
 */
const ANON_IP_CEILING = 5

export type PaywallReason = 'email' | 'daily_cap' | 'ip_exhausted' | 'user_cap'

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

export function userBucketKey(userId: string): string {
  return `bucket:user:${userId}`
}

async function bucketCfg(store: GradeStore, cookie: string): Promise<{
  limit: number
  paywall: PaywallReason
  isAnonymous: boolean
  userId: string | null
}> {
  const row = await store.getCookieWithUserAndCredits(cookie)
  const isAnonymous = row.userId === null
  // Paywall still distinguishes anon ('email', prompts sign-in) from
  // verified ('daily_cap' — frontend checks credits to decide whether to
  // offer the "Grade (1 credit)" overflow). Limit is uniform.
  return {
    limit: DAILY_LIMIT,
    paywall: isAnonymous ? 'email' : 'daily_cap',
    isAnonymous,
    userId: row.userId,
  }
}

export async function peekRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, now: number = Date.now(),
): Promise<RateLimitPeekResult> {
  const { limit, paywall, isAnonymous, userId } = await bucketCfg(store, cookie)

  // Anonymous callers hit the per-IP ceiling first — defends against the
  // incognito-spam case where someone rotates cookies on one IP.
  if (isAnonymous) {
    const ipCfg = { key: anonIpBucketKey(ip), limit: ANON_IP_CEILING, windowMs: WINDOW_MS }
    const ipPeek = await peekBucket(redis, ipCfg, now)
    if (!ipPeek.allowed) {
      return { ...ipPeek, paywall: 'ip_exhausted' }
    }
  }

  // Cookie bucket first — when credit-holders saturate their 10/day on a
  // single cookie, we want the specific 'daily_cap' paywall to surface,
  // not the more generic 'user_cap'.
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  const peek = await peekBucket(redis, cfg, now)
  if (!peek.allowed) return { ...peek, paywall }

  // Per-user ceiling (same `limit` as the cookie bucket, keyed on userId).
  // Without this, a signed-in user with multiple browsers/incognito
  // sessions gets `limit` grades per cookie with no overall cap —
  // effectively unlimited free grades. Runs only when the cookie itself
  // passed, so the user_cap verdict is stable regardless of which cookie
  // the caller happens to be using right now.
  if (userId !== null) {
    const userCfg = { key: userBucketKey(userId), limit, windowMs: WINDOW_MS }
    const userPeek = await peekBucket(redis, userCfg, now)
    if (!userPeek.allowed) {
      return { ...userPeek, paywall: 'user_cap' }
    }
  }

  return { ...peek, paywall }
}

export async function commitRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, gradeId: string, now: number = Date.now(),
): Promise<void> {
  const { limit, isAnonymous, userId } = await bucketCfg(store, cookie)
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  await addToBucket(redis, cfg, now, gradeBucketMember(gradeId))

  if (isAnonymous) {
    const ipCfg = { key: anonIpBucketKey(ip), limit: ANON_IP_CEILING, windowMs: WINDOW_MS }
    await addToBucket(redis, ipCfg, now, gradeBucketMember(gradeId))
  }

  if (userId !== null) {
    const userCfg = { key: userBucketKey(userId), limit, windowMs: WINDOW_MS }
    await addToBucket(redis, userCfg, now, gradeBucketMember(gradeId))
  }
}

export async function refundRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, gradeId: string,
): Promise<void> {
  // Refund from every bucket this grade might have counted in. zrem of a
  // non-existent member is a no-op, so paying the cost of both anon-IP and
  // user-bucket cleanup is cheap even when only one applies.
  const member = gradeBucketMember(gradeId)
  await removeFromBucket(redis, { key: gradeBucketKey(ip, cookie) }, member)
  await removeFromBucket(redis, { key: anonIpBucketKey(ip) }, member)
  const { userId } = await bucketCfg(store, cookie)
  if (userId !== null) {
    await removeFromBucket(redis, { key: userBucketKey(userId) }, member)
  }
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
