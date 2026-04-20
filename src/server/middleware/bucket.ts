import type Redis from 'ioredis'

export interface BucketConfig {
  key: string
  limit: number
  windowMs: number
}

export interface BucketResult {
  allowed: boolean
  limit: number
  used: number
  retryAfter: number
}

export async function peekBucket(redis: Redis, cfg: BucketConfig, now: number): Promise<BucketResult> {
  const cutoff = now - cfg.windowMs
  await redis.zremrangebyscore(cfg.key, '-inf', String(cutoff - 1))
  const used = await redis.zcard(cfg.key)
  if (used >= cfg.limit) {
    const range = await redis.zrange(cfg.key, 0, 0, 'WITHSCORES')
    const oldestScore = range.length >= 2 ? Number(range[1]) : now
    const retryAfter = Math.ceil((oldestScore + cfg.windowMs - now) / 1000)
    return { allowed: false, limit: cfg.limit, used, retryAfter }
  }
  return { allowed: true, limit: cfg.limit, used, retryAfter: 0 }
}

export async function addToBucket(
  redis: Redis, cfg: BucketConfig, now: number, member: string,
): Promise<void> {
  await redis.zadd(cfg.key, now, member)
  await redis.expire(cfg.key, Math.ceil(cfg.windowMs / 1000))
}

export async function removeFromBucket(
  redis: Redis, cfg: { key: string }, member: string,
): Promise<void> {
  await redis.zrem(cfg.key, member)
}
