#!/usr/bin/env tsx
/**
 * Dump the current rate-limit bucket state for a user + cookie. Useful for
 * diagnosing "why didn't this get blocked" / "where did my slots go".
 *
 * Usage:
 *   REDIS_URL=<url> pnpm tsx scripts/diagnose-rate-limit.ts <userId> [cookie]
 *
 * Shows every non-empty bucket key that mentions the user or cookie, with
 * its members (grade:<uuid>) and their age.
 */

import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL
if (!REDIS_URL) {
  console.error('REDIS_URL is required. Pass it inline.')
  process.exit(1)
}

const userId = process.argv[2]
const cookie = process.argv[3]

if (!userId) {
  console.error('Usage: diagnose-rate-limit.ts <userId> [cookie]')
  process.exit(1)
}

async function dumpBucket(redis: Redis, key: string): Promise<void> {
  const count = await redis.zcard(key)
  if (count === 0) {
    console.log(`  ${key}  → empty`)
    return
  }
  const members = await redis.zrange(key, 0, -1, 'WITHSCORES')
  console.log(`  ${key}  → ${count} entries`)
  const now = Date.now()
  for (let i = 0; i < members.length; i += 2) {
    const member = members[i]
    const score = Number(members[i + 1])
    const ageSec = Math.floor((now - score) / 1000)
    console.log(`    ${member}   age=${ageSec}s  score=${score}`)
  }
}

async function main(): Promise<void> {
  const redis = new Redis(REDIS_URL!)
  console.log(`User:   ${userId}`)
  if (cookie) console.log(`Cookie: ${cookie}`)
  console.log('')

  console.log('── Per-user bucket (the F-3 / cookie-rotation fix) ──')
  await dumpBucket(redis, `bucket:user:${userId}`)

  if (cookie) {
    console.log('')
    console.log('── Cookie buckets for this cookie (across IPs) ──')
    const scanned = new Set<string>()
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `bucket:ip:*+cookie:${cookie}`, 'COUNT', 100)
      for (const k of keys) scanned.add(k)
      cursor = next
    } while (cursor !== '0')
    if (scanned.size === 0) {
      console.log(`  (no bucket:ip:*+cookie:${cookie} keys found)`)
    } else {
      for (const k of scanned) await dumpBucket(redis, k)
    }
  }

  console.log('')
  console.log('── Anon-IP buckets (not user-scoped; shown for context) ──')
  {
    let cursor = '0'
    const keys = new Set<string>()
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', 'bucket:ip-anon:*', 'COUNT', 100)
      for (const k of found) keys.add(k)
      cursor = next
    } while (cursor !== '0')
    if (keys.size === 0) {
      console.log('  (no anon-IP buckets)')
    } else {
      for (const k of keys) await dumpBucket(redis, k)
    }
  }

  await redis.quit()
  process.exit(0)
}

main().catch((err) => {
  console.error('diagnose-rate-limit crashed:', err)
  process.exit(1)
})
