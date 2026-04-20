import { describe, it, expect, beforeEach } from 'vitest'
import { makeStubRedis } from '../../_helpers/stub-redis.ts'
import { peekBucket, addToBucket, removeFromBucket } from '../../../../src/server/middleware/bucket.ts'

describe('bucket', () => {
  const cfg = { key: 'bucket:test', limit: 3, windowMs: 60_000 }
  let redis: ReturnType<typeof makeStubRedis>
  beforeEach(() => { redis = makeStubRedis() })

  it('addToBucket with named member stores that exact member', async () => {
    await addToBucket(redis, cfg, 1000, 'grade:abc')
    const peek = await peekBucket(redis, cfg, 1000)
    expect(peek.used).toBe(1)
  })

  it('removeFromBucket removes exactly the named member (refund)', async () => {
    await addToBucket(redis, cfg, 1000, 'grade:abc')
    await addToBucket(redis, cfg, 1001, 'grade:def')
    await removeFromBucket(redis, { key: cfg.key }, 'grade:abc')
    const peek = await peekBucket(redis, cfg, 2000)
    expect(peek.used).toBe(1)
  })

  it('removeFromBucket on unknown member is a no-op', async () => {
    await addToBucket(redis, cfg, 1000, 'grade:abc')
    await removeFromBucket(redis, { key: cfg.key }, 'grade:zzz')
    const peek = await peekBucket(redis, cfg, 2000)
    expect(peek.used).toBe(1)
  })
})
