import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import type { ServerDeps } from './deps.ts'
import { clientIp } from './middleware/client-ip.ts'
import { cookieMiddleware } from './middleware/cookie.ts'
import { rateLimitMiddleware } from './middleware/rate-limit.ts'
import { gradesRouter } from './routes/grades.ts'
import { gradesEventsRouter } from './routes/grades-events.ts'
import { authRouter } from './routes/auth.ts'

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
  gradeScope.use('*', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  gradeScope.post('/', rateLimitMiddleware(deps.redis, deps.store))
  gradeScope.route('/', gradesRouter(deps))
  gradeScope.route('/', gradesEventsRouter(deps))

  app.route('/grades', gradeScope)

  const authScope = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  authScope.use('*', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  authScope.route('/', authRouter({
    store: deps.store,
    redis: deps.redis,
    mailer: deps.mailer,
    publicBaseUrl: deps.env.PUBLIC_BASE_URL,
  }))
  app.route('/auth', authScope)

  if (deps.env.NODE_ENV === 'production') {
    // Serve built frontend from dist/web. Catch-all falls through to index.html
    // so React Router handles deep links (e.g. /g/:id) on page refresh.
    app.use('/assets/*', serveStatic({ root: './dist/web' }))
    app.get('*', serveStatic({ root: './dist/web', path: 'index.html' }))
  }

  return app
}
