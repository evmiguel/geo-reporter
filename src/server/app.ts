import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import type { ServerDeps } from './deps.ts'
import { clientIp } from './middleware/client-ip.ts'
import { cookieMiddleware } from './middleware/cookie.ts'
import { rateLimitMiddleware } from './middleware/rate-limit.ts'
import { requestLog } from './middleware/request-log.ts'
import { gradesRouter } from './routes/grades.ts'
import { gradesEventsRouter } from './routes/grades-events.ts'
import { authRouter } from './routes/auth.ts'
import { billingRouter } from './routes/billing.ts'
import { contactRouter } from './routes/contact.ts'
import { reportRouter } from './routes/report.ts'

export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono()

  const clientIpOpts = { isProduction: deps.env.NODE_ENV === 'production' }

  app.use('*', requestLog())

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

  const gradeScope = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
  gradeScope.use('*', clientIp(clientIpOpts), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  gradeScope.post('/', rateLimitMiddleware(deps.redis, deps.store))
  gradeScope.route('/', gradesRouter(deps))
  gradeScope.route('/', gradesEventsRouter(deps))

  app.route('/grades', gradeScope)

  const authScope = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
  authScope.use('*', clientIp(clientIpOpts), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  authScope.route('/', authRouter({
    store: deps.store,
    redis: deps.redis,
    mailer: deps.mailer,
    publicBaseUrl: deps.env.PUBLIC_BASE_URL,
    nodeEnv: deps.env.NODE_ENV,
    turnstileSecretKey: deps.env.TURNSTILE_SECRET_KEY ?? null,
  }))
  app.route('/auth', authScope)

  if (deps.billing && deps.env.STRIPE_PRICE_ID && deps.env.STRIPE_WEBHOOK_SECRET) {
    const billing = deps.billing
    const priceId = deps.env.STRIPE_PRICE_ID
    const webhookSecret = deps.env.STRIPE_WEBHOOK_SECRET
    const creditsPriceId = deps.env.STRIPE_CREDITS_PRICE_ID ?? ''
    const billingScope = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
    // Cookie middleware only on /checkout and /buy-credits; webhook explicitly skips it (Stripe doesn't send cookies).
    billingScope.use('/checkout', clientIp(clientIpOpts), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
    billingScope.use('/buy-credits', clientIp(clientIpOpts), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
    billingScope.use('/redeem-credit', clientIp(clientIpOpts), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
    billingScope.route('/', billingRouter({
      store: deps.store, billing, redis: deps.redis, priceId, creditsPriceId,
      publicBaseUrl: deps.env.PUBLIC_BASE_URL,
      webhookSecret, reportQueue: deps.reportQueue,
    }))
    app.route('/billing', billingScope)
  } else {
    app.post('/billing/checkout', (c) => c.json({ error: 'stripe_not_configured' }, 503))
    app.post('/billing/redeem-credit', (c) => c.json({ error: 'stripe_not_configured' }, 503))
    app.post('/billing/webhook', (c) => c.json({ error: 'stripe_not_configured' }, 503))
    if (deps.env.NODE_ENV !== 'test') {
      console.warn('Stripe not configured — /billing endpoints return 503. Set STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET/STRIPE_PRICE_ID.')
    }
  }

  const contactScope = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
  contactScope.use('*', clientIp(clientIpOpts), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  contactScope.route('/', contactRouter({
    store: deps.store,
    redis: deps.redis,
    mailer: deps.mailer,
    turnstileSecretKey: deps.env.TURNSTILE_SECRET_KEY ?? null,
  }))
  app.route('/contact', contactScope)

  app.route('/report', reportRouter({ store: deps.store }))

  if (deps.env.NODE_ENV === 'production') {
    // Serve built frontend from dist/web. Catch-all falls through to index.html
    // so React Router handles deep links (e.g. /g/:id) on page refresh.
    app.use('/assets/*', serveStatic({ root: './dist/web' }))
    app.get('*', serveStatic({ root: './dist/web', path: 'index.html' }))
  }

  return app
}
