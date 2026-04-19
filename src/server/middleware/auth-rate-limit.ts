import type Redis from 'ioredis'
import { peekBucket, addToBucket, type BucketResult, type BucketConfig } from './bucket.ts'

const EMAIL_CFG = (email: string): BucketConfig => ({
  key: `magic:email:${email}`,
  limit: 1,
  windowMs: 60_000,
})

const IP_CFG = (ip: string): BucketConfig => ({
  key: `magic:ip:${ip}`,
  limit: 5,
  windowMs: 600_000,
})

export async function peekMagicEmailBucket(redis: Redis, email: string, now: number = Date.now()): Promise<BucketResult> {
  return peekBucket(redis, EMAIL_CFG(email), now)
}

export async function peekMagicIpBucket(redis: Redis, ip: string, now: number = Date.now()): Promise<BucketResult> {
  return peekBucket(redis, IP_CFG(ip), now)
}

export async function addMagicEmailBucket(redis: Redis, email: string, now: number = Date.now()): Promise<void> {
  return addToBucket(redis, EMAIL_CFG(email), now)
}

export async function addMagicIpBucket(redis: Redis, ip: string, now: number = Date.now()): Promise<void> {
  return addToBucket(redis, IP_CFG(ip), now)
}
