import { serve } from '@hono/node-server'
import { sql } from 'drizzle-orm'
import { env } from '../config/env.ts'
import { db, closeDb } from '../db/client.ts'
import { PostgresStore } from '../store/postgres.ts'
import { createRedis } from '../queue/redis.ts'
import { ConsoleMailer } from '../mail/console-mailer.ts'
import { buildApp } from './app.ts'

const redis = createRedis(env.REDIS_URL)
const store = new PostgresStore(db)

const DEV_HMAC_FALLBACK = 'dev-insecure-hmac-key-do-not-use-in-prod-aa'
const DEV_PUBLIC_BASE_URL = 'http://localhost:5173'

let cookieHmacKey = env.COOKIE_HMAC_KEY
if (!cookieHmacKey) {
  if (env.NODE_ENV === 'production') {
    throw new Error('COOKIE_HMAC_KEY required in production')
  }
  console.warn('COOKIE_HMAC_KEY not set — using insecure dev default. DO NOT deploy like this.')
  cookieHmacKey = DEV_HMAC_FALLBACK
}

let publicBaseUrl = env.PUBLIC_BASE_URL
if (!publicBaseUrl) {
  if (env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_BASE_URL required in production')
  }
  console.warn(`PUBLIC_BASE_URL not set — falling back to ${DEV_PUBLIC_BASE_URL}.`)
  publicBaseUrl = DEV_PUBLIC_BASE_URL
}

const mailer = new ConsoleMailer()

const app = buildApp({
  store,
  redis,
  redisFactory: () => createRedis(env.REDIS_URL),
  mailer,
  pingDb: async () => {
    try { await db.execute(sql`select 1`); return true } catch { return false }
  },
  pingRedis: async () => (await redis.ping()) === 'PONG',
  env: {
    NODE_ENV: env.NODE_ENV,
    COOKIE_HMAC_KEY: cookieHmacKey,
    PUBLIC_BASE_URL: publicBaseUrl,
  },
})

const server = serve({ fetch: app.fetch, port: env.PORT })
console.log(JSON.stringify({ msg: 'server listening', port: env.PORT }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'server shutting down', signal }))
  server.close()
  await redis.quit()
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
