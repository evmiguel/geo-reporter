import { Hono } from 'hono'
import type { ServerDeps } from './deps.ts'

export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono()

  app.get('/healthz', async (c) => {
    const [dbResult, redisResult] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()])
    const db = dbResult.status === 'fulfilled' && dbResult.value === true
    const redis = redisResult.status === 'fulfilled' && redisResult.value === true
    const ok = db && redis
    return c.json({ ok, db, redis }, ok ? 200 : 503)
  })

  return app
}
