import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import * as schema from '../../src/db/schema.ts'
import { buildApp } from '../../src/server/app.ts'
import type { ServerDeps } from '../../src/server/deps.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { createRedis } from '../../src/queue/redis.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'

let pg: StartedPostgreSqlContainer
let redisContainer: StartedTestContainer
let stop: () => Promise<void>

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start()
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  const pgClient = postgres(pg.getConnectionUri(), { prepare: false, max: 2 })
  const db = drizzle(pgClient, { schema })
  await migrate(db, { migrationsFolder: './src/db/migrations' })
  const redis = createRedis(`redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`)
  const store = new PostgresStore(db)

  stop = async () => {
    await pgClient.end({ timeout: 5 })
    await redis.quit()
    await pg.stop()
    await redisContainer.stop()
  }

  const deps: ServerDeps = {
    store,
    redis,
    redisFactory: () => createRedis(`redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`),
    mailer: new FakeMailer(),
    pingDb: async () => {
      try { await db.execute(sql`select 1`); return true } catch { return false }
    },
    pingRedis: async () => (await redis.ping()) === 'PONG',
    env: {
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
      PUBLIC_BASE_URL: 'http://localhost:5173',
    },
  }
  ;(globalThis as any).__app = buildApp(deps)
}, 60_000)

afterAll(async () => {
  await stop()
})

describe('/healthz (integration)', () => {
  it('returns ok against real postgres + redis', async () => {
    const res = await (globalThis as any).__app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: true, redis: true })
  })
})
