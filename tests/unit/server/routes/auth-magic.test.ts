import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import RedisMock from 'ioredis-mock'
import type IoRedis from 'ioredis'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'
import { authRouter } from '../../../../src/server/routes/auth.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'
const PUBLIC_BASE_URL = 'http://localhost:5173'

// ioredis-mock v6+ shares state across instances with the same host/port.
// Flush between tests to keep bucket state isolated.
beforeEach(async () => {
  const r = new RedisMock()
  await r.flushall()
})

function buildAuthApp() {
  const store = makeFakeStore()
  const mailer = new FakeMailer()
  const redis = new RedisMock() as unknown as IoRedis
  const app = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
  app.use('*', clientIp({ isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/auth', authRouter({
    store,
    redis,
    mailer,
    publicBaseUrl: PUBLIC_BASE_URL,
  }))
  return { app, store, mailer, redis }
}

type AppType = Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>

async function issueCookie(app: AppType): Promise<string> {
  // /auth/me will be added in Task 12. For Task 10 we just want a fresh signed cookie.
  // Use a placeholder route registered only for this test-scope: hit POST /auth/magic with a bad body —
  // middleware runs first, so we get the Set-Cookie header even on a 400.
  const res = await app.fetch(new Request('http://test/auth/magic', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }))
  const setCookie = res.headers.get('set-cookie') ?? ''
  const raw = setCookie.split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('POST /auth/magic', () => {
  it('issues token, calls mailer, returns 204', async () => {
    const { app, mailer } = buildAuthApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'user@example.com' }),
    }))
    expect(res.status).toBe(204)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]!.email).toBe('user@example.com')
    expect(mailer.sent[0]!.url).toMatch(/^http:\/\/localhost:5173\/auth\/verify\?t=[A-Za-z0-9_-]+$/)
  })

  it('rejects malformed email with 400', async () => {
    const { app } = buildAuthApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'not-an-email' }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_email')
  })

  it('normalizes email (trim + lowercase)', async () => {
    const { app, mailer } = buildAuthApp()
    const cookie = await issueCookie(app)
    await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: '  USER@Example.COM  ' }),
    }))
    expect(mailer.sent[0]!.email).toBe('user@example.com')
  })

  it('per-email rate-limit returns 429 with paywall=email_cooldown', async () => {
    const { app } = buildAuthApp()
    const cookie = await issueCookie(app)
    const post = () => app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'a@b.com' }),
    }))
    await post()
    const second = await post()
    expect(second.status).toBe(429)
    const body = await second.json() as { paywall: string; limit: number }
    expect(body.paywall).toBe('email_cooldown')
    expect(body.limit).toBe(1)
  })

  it('per-ip rate-limit returns 429 with paywall=ip_cooldown after 5 different emails', async () => {
    const { app } = buildAuthApp()
    const cookie = await issueCookie(app)
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(new Request('http://test/auth/magic', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
        body: JSON.stringify({ email: `u${i}@b.com` }),
      }))
      expect(res.status).toBe(204)
    }
    const sixth = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'u5@b.com' }),
    }))
    expect(sixth.status).toBe(429)
    const body = await sixth.json() as { paywall: string; limit: number }
    expect(body.paywall).toBe('ip_cooldown')
    expect(body.limit).toBe(5)
  })
})
