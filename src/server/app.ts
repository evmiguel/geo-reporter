import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ServerDeps } from './deps.ts'
import { clientIp } from './middleware/client-ip.ts'
import { cookieMiddleware } from './middleware/cookie.ts'
import { rateLimitMiddleware } from './middleware/rate-limit.ts'
import { gradesRouter } from './routes/grades.ts'

export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono()

  app.get('/healthz', async (c) => {
    const [dbResult, redisResult] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()])
    const db = dbResult.status === 'fulfilled' && dbResult.value === true
    const redis = redisResult.status === 'fulfilled' && redisResult.value === true
    const ok = db && redis
    return c.json({ ok, db, redis }, ok ? 200 : 503)
  })

  if (deps.env.NODE_ENV === 'development') {
    app.use('*', cors({ origin: 'http://localhost:5173', credentials: true }))
  }

  const gradeScope = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  gradeScope.use('*', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production'))
  gradeScope.post('/', rateLimitMiddleware(deps.redis, deps.store))
  gradeScope.route('/', gradesRouter(deps))

  app.route('/grades', gradeScope)
  return app
}
