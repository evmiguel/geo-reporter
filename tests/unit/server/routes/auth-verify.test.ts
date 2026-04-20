import { beforeEach, describe, it, expect } from 'vitest'
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

type AppType = Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>

let sharedRedis: IoRedis | null = null
beforeEach(async () => {
  if (sharedRedis) {
    await sharedRedis.flushall()
  }
})

function build(): { app: AppType; store: ReturnType<typeof makeFakeStore>; mailer: FakeMailer } {
  const store = makeFakeStore()
  const mailer = new FakeMailer()
  const redis = new RedisMock() as unknown as IoRedis
  sharedRedis = redis
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
  app.use('*', clientIp({ isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/auth', authRouter({ store, redis, mailer, publicBaseUrl: PUBLIC_BASE_URL }))
  return { app, store, mailer }
}

async function issueCookie(app: AppType): Promise<string> {
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

async function getTokenFromMailer(app: AppType, mailer: FakeMailer, email: string, cookie: string): Promise<string> {
  await app.fetch(new Request('http://test/auth/magic', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify({ email }),
  }))
  const url = new URL(mailer.sent.at(-1)!.url)
  return url.searchParams.get('t')!
}

describe('GET /auth/verify', () => {
  it('happy path: redirects to /?verified=1 and binds clicking cookie', async () => {
    const { app, store, mailer } = build()
    const cookie = await issueCookie(app)
    const token = await getTokenFromMailer(app, mailer, 'user@example.com', cookie)
    const res = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?verified=1')
    const uuid = cookie.split('.')[0]!
    const row = await store.getCookie(uuid)
    expect(row!.userId).not.toBeNull()
  })

  it('missing t redirects to /?auth_error=expired_or_invalid', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/verify', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  })

  it('malformed t (non-base64url chars) redirects to auth_error', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/verify?t=has+spaces/and=plus', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  })

  it('unknown token redirects to auth_error', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/verify?t=' + 'a'.repeat(43), {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  })

  it('already-consumed token redirects to auth_error', async () => {
    const { app, mailer } = build()
    const cookie = await issueCookie(app)
    const token = await getTokenFromMailer(app, mailer, 'user@example.com', cookie)
    await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    const second = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(second.status).toBe(302)
    expect(second.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  })

  it('only the clicking cookie gets bound', async () => {
    const { app, store, mailer } = build()
    const issuingCookie = await issueCookie(app)
    const token = await getTokenFromMailer(app, mailer, 'user@example.com', issuingCookie)
    const clickingCookie = await issueCookie(app)
    await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${clickingCookie}` },
    }))
    const issuingUuid = issuingCookie.split('.')[0]!
    const clickingUuid = clickingCookie.split('.')[0]!
    const issuing = await store.getCookie(issuingUuid)
    const clicking = await store.getCookie(clickingUuid)
    expect(issuing!.userId).toBeNull()
    expect(clicking!.userId).not.toBeNull()
  })
})
