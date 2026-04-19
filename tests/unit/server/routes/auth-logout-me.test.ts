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

type AppType = Hono<{ Variables: { cookie: string; clientIp: string } }>

let sharedRedis: IoRedis | null = null
beforeEach(async () => { if (sharedRedis) await sharedRedis.flushall() })

function build(): { app: AppType; store: ReturnType<typeof makeFakeStore>; mailer: FakeMailer } {
  const store = makeFakeStore()
  const mailer = new FakeMailer()
  const redis = new RedisMock() as unknown as IoRedis
  sharedRedis = redis
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/auth', authRouter({ store, redis, mailer, publicBaseUrl: 'http://localhost:5173' }))
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

async function verifyForUser(app: AppType, mailer: FakeMailer, cookie: string, email: string): Promise<void> {
  await app.fetch(new Request('http://test/auth/magic', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify({ email }),
  }))
  const token = new URL(mailer.sent.at(-1)!.url).searchParams.get('t')!
  await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
    headers: { cookie: `ggcookie=${cookie}` },
  }))
}

describe('GET /auth/me', () => {
  it('returns verified:false for a fresh cookie', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/me', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ verified: false })
  })

  it('returns verified:true + email after verify', async () => {
    const { app, mailer } = build()
    const cookie = await issueCookie(app)
    await verifyForUser(app, mailer, cookie, 'user@example.com')
    const res = await app.fetch(new Request('http://test/auth/me', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(await res.json()).toEqual({ verified: true, email: 'user@example.com' })
  })
})

describe('POST /auth/logout', () => {
  it('clears user_id on the cookie; /auth/me returns verified:false', async () => {
    const { app, mailer } = build()
    const cookie = await issueCookie(app)
    await verifyForUser(app, mailer, cookie, 'user@example.com')
    const logoutRes = await app.fetch(new Request('http://test/auth/logout', {
      method: 'POST',
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(logoutRes.status).toBe(204)
    const meRes = await app.fetch(new Request('http://test/auth/me', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(await meRes.json()).toEqual({ verified: false })
  })
})
