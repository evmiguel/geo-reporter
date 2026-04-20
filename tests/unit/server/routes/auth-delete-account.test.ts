import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { authRouter } from '../../../../src/server/routes/auth.ts'
import { cookieMiddleware, COOKIE_NAME } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

type AppType = Hono<{ Variables: { cookie: string; clientIp: string } }>

function build() {
  const store = makeFakeStore()
  const mailer = new FakeMailer()
  const redis = {} as never  // delete-account doesn't hit Redis
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp({ isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/auth', authRouter({
    store, redis, mailer,
    publicBaseUrl: 'http://localhost', nodeEnv: 'test',
  }))
  return { app, store }
}

async function issueCookie(app: AppType): Promise<string> {
  const res = await app.fetch(new Request('http://test/auth/me'))
  const raw = (res.headers.get('set-cookie') ?? '').split(`${COOKIE_NAME}=`)[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('POST /auth/delete-account', () => {
  it('401 when cookie is not bound to a user', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({ email: 'anyone@example.com' }),
    }))
    expect(res.status).toBe(401)
  })

  it('400 email_mismatch when typed email does not match logged-in user', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('real@example.com')
    await store.upsertCookie(uuid, user.id)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({ email: 'someone-else@example.com' }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('email_mismatch')
  })

  it('204 happy path; clears cookie', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('gone@example.com')
    await store.upsertCookie(uuid, user.id)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({ email: 'gone@example.com' }),
    }))
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(new RegExp(`${COOKIE_NAME}=;`))
    expect(setCookie).toMatch(/Max-Age=0/)
  })

  it('400 on malformed body (missing email)', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@example.com')
    await store.upsertCookie(uuid, user.id)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({}),
    }))
    expect(res.status).toBe(400)
  })

  it('email comparison is case-insensitive', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('case@example.com')
    await store.upsertCookie(uuid, user.id)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({ email: 'CASE@EXAMPLE.COM' }),
    }))
    expect(res.status).toBe(204)
  })
})
