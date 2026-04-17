import { serve } from '@hono/node-server'
import { sql } from 'drizzle-orm'
import { env } from '../config/env.ts'
import { db } from '../db/client.ts'
import { createRedis } from '../queue/redis.ts'
import { buildApp } from './app.ts'

const redis = createRedis(env.REDIS_URL)

const app = buildApp({
  pingDb: async () => {
    try {
      await db.execute(sql`select 1`)
      return true
    } catch { return false }
  },
  pingRedis: async () => (await redis.ping()) === 'PONG',
})

const server = serve({ fetch: app.fetch, port: env.PORT })
console.log(JSON.stringify({ msg: 'server listening', port: env.PORT }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'server shutting down', signal }))
  server.close()
  await redis.quit()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
