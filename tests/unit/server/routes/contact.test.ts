import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import RedisMock from 'ioredis-mock'
import type IoRedis from 'ioredis'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'
import { contactRouter } from '../../../../src/server/routes/contact.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

// ioredis-mock v6+ shares state across instances with the same host/port.
// Flush between tests to keep bucket state isolated.
beforeEach(async () => {
  const r = new RedisMock()
  await r.flushall()
})

interface BuildOpts {
  turnstileSecretKey?: string | null
}

function buildContactApp(opts: BuildOpts = {}): {
  app: Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>
  mailer: FakeMailer
  redis: IoRedis
} {
  const store = makeFakeStore()
  const mailer = new FakeMailer()
  const redis = new RedisMock() as unknown as IoRedis
  const app = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
  app.use('*', clientIp({ isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/contact', contactRouter({
    store,
    redis,
    mailer,
    turnstileSecretKey: opts.turnstileSecretKey ?? null,
  }))
  return { app, mailer, redis }
}

type AppType = Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>

async function issueCookie(app: AppType): Promise<string> {
  // Hit POST /contact with a bad body — middleware runs first and issues the
  // signed cookie, so we get Set-Cookie back even on a 400.
  const res = await app.fetch(new Request('http://test/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }))
  const setCookie = res.headers.get('set-cookie') ?? ''
  const raw = setCookie.split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

function contactReq(cookie: string, body: unknown): Request {
  return new Request('http://test/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify(body),
  })
}

describe('POST /contact', () => {
  it('records the message via mailer and returns 204', async () => {
    const { app, mailer } = buildContactApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(contactReq(cookie, {
      email: 'me@example.com',
      category: 'bug',
      body: 'Found a bug in the grade page.',
    }))
    expect(res.status).toBe(204)
    expect(mailer.contactMessages).toHaveLength(1)
    expect(mailer.contactMessages[0]).toMatchObject({
      fromEmail: 'me@example.com',
      category: 'bug',
      body: 'Found a bug in the grade page.',
    })
  })

  it('normalizes email (trim + lowercase)', async () => {
    const { app, mailer } = buildContactApp()
    const cookie = await issueCookie(app)
    await app.fetch(contactReq(cookie, {
      email: '  ME@Example.COM  ',
      category: 'other',
      body: 'Hello there, have a question.',
    }))
    expect(mailer.contactMessages[0]!.fromEmail).toBe('me@example.com')
  })

  it('rejects missing fields with 400', async () => {
    const { app } = buildContactApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(contactReq(cookie, { email: 'me@example.com' }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_body')
  })

  it('rejects body shorter than 10 chars with 400', async () => {
    const { app } = buildContactApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(contactReq(cookie, {
      email: 'me@example.com',
      category: 'bug',
      body: 'too short',
    }))
    expect(res.status).toBe(400)
  })

  it('rejects invalid email format with 400', async () => {
    const { app } = buildContactApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(contactReq(cookie, {
      email: 'not-an-email',
      category: 'bug',
      body: 'Here is a message long enough.',
    }))
    expect(res.status).toBe(400)
  })

  it('rejects unknown category with 400', async () => {
    const { app } = buildContactApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(contactReq(cookie, {
      email: 'me@example.com',
      category: 'spam',
      body: 'Here is a message long enough.',
    }))
    expect(res.status).toBe(400)
  })

  it('returns 429 after 5 messages in the same window', async () => {
    const { app } = buildContactApp()
    const cookie = await issueCookie(app)
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(contactReq(cookie, {
        email: `u${i}@b.com`,
        category: 'other',
        body: `Message number ${i}, long enough to pass.`,
      }))
      expect(res.status).toBe(204)
    }
    const sixth = await app.fetch(contactReq(cookie, {
      email: 'u5@b.com',
      category: 'other',
      body: 'Message number 5, long enough to pass.',
    }))
    expect(sixth.status).toBe(429)
    const body = await sixth.json() as { error: string; retryAfter: number }
    expect(body.error).toBe('rate_limited')
    expect(typeof body.retryAfter).toBe('number')
  })

  it('returns 403 when Turnstile is configured and no token is sent', async () => {
    const { app, mailer } = buildContactApp({ turnstileSecretKey: 'secret_xxx' })
    const cookie = await issueCookie(app)
    const res = await app.fetch(contactReq(cookie, {
      email: 'me@example.com',
      category: 'bug',
      body: 'Here is a message long enough.',
    }))
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('captcha_failed')
    expect(mailer.contactMessages).toHaveLength(0)
  })
})
