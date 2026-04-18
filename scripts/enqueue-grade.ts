#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto'
import { env } from '../src/config/env.ts'
import { db, closeDb } from '../src/db/client.ts'
import { PostgresStore } from '../src/store/postgres.ts'
import { createRedis } from '../src/queue/redis.ts'
import { enqueueGrade } from '../src/queue/queues.ts'

const [, , urlArg, tierFlag] = process.argv
if (!urlArg) {
  console.error('usage: pnpm enqueue-grade <url> [--paid]')
  process.exit(1)
}
const tier: 'free' | 'paid' = tierFlag === '--paid' ? 'paid' : 'free'

let parsed: URL
try {
  parsed = new URL(urlArg)
} catch {
  console.error(`invalid URL: ${urlArg}`)
  process.exit(1)
}
const domain = parsed.hostname.toLowerCase().replace(/^www\./, '')

const cookie = `dev-cli-${randomUUID()}`
const store = new PostgresStore(db)
const redis = createRedis(env.REDIS_URL)

await store.upsertCookie(cookie)
const grade = await store.createGrade({
  url: urlArg, domain, tier, cookie, userId: null, status: 'queued',
})
await enqueueGrade({ gradeId: grade.id, tier }, redis)

console.log(`enqueued grade ${grade.id} (tier=${tier}) for ${urlArg}`)
console.log(`watch: redis-cli -p 63790 subscribe grade:${grade.id}`)

await redis.quit()
await closeDb()
