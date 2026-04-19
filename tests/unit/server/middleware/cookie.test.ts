import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { signCookie } from '../../../../src/server/middleware/cookie-sign.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import type { FakeGradeStore } from '../../_helpers/fake-store.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

function buildTestApp(
  store: FakeGradeStore = makeFakeStore(),
  hmacKey: string = HMAC_KEY,
  isProduction: boolean = false,
) {
  const app = new Hono<{ Variables: { cookie: string } }>()
  app.use('*', cookieMiddleware(store, isProduction, hmacKey))
  app.get('/', (c) => c.json({ cookie: c.var.cookie }))
  return { app, store }
}

describe('cookie middleware', () => {
  it('issues a new UUID cookie when none present', async () => {
    const { app, store } = buildTestApp()
    const res = await app.request('/')
    const body = (await res.json()) as { cookie: string }
    expect(body.cookie).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toMatch(/^ggcookie=/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toMatch(/Max-Age=\d+/)
    expect(setCookie).not.toContain('Secure')   // not prod
    expect(store.cookiesMap.size).toBe(1)
  })

  it('includes Secure when isProduction=true', async () => {
    const { app } = buildTestApp(makeFakeStore(), HMAC_KEY, true)
    const res = await app.request('/')
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('Secure')
  })

  it('reuses an existing cookie and does not re-issue', async () => {
    const store = makeFakeStore()
    const preset = '11111111-2222-3333-4444-555555555555'
    await store.upsertCookie(preset)
    const signedPreset = signCookie(preset, HMAC_KEY)
    const { app } = buildTestApp(store)
    const res = await app.request('/', { headers: { cookie: `ggcookie=${signedPreset}` } })
    const body = (await res.json()) as { cookie: string }
    expect(body.cookie).toBe(preset)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(store.cookiesMap.size).toBe(1)   // no new rows
  })

  it('calls upsertCookie exactly once on issuance', async () => {
    const { app, store } = buildTestApp()
    await app.request('/')
    const issued = [...store.cookiesMap.keys()][0]!
    const signed = signCookie(issued, HMAC_KEY)
    await app.request('/', { headers: { cookie: `ggcookie=${signed}` } })
    // First request: upsertCookie called once (issuance).
    // Second request: cookie exists and is valid-signed, no upsert.
    expect(store.cookiesMap.size).toBe(1)
  })
})

describe('cookie middleware — Plan 7 HMAC', () => {
  it('accepts a validly signed cookie unchanged', async () => {
    const uuid = crypto.randomUUID()
    const signed = signCookie(uuid, HMAC_KEY)
    const store = makeFakeStore()
    await store.upsertCookie(uuid)
    const { app } = buildTestApp(store)
    const res = await app.request('/', { headers: { cookie: `ggcookie=${signed}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    const body = (await res.json()) as { cookie: string }
    expect(body.cookie).toBe(uuid)
  })

  it('rejects tampered signature and issues a fresh cookie', async () => {
    const uuid = crypto.randomUUID()
    const { app } = buildTestApp()
    const tampered = `${uuid}.AAAAAAAAAAAAAAAAAAAAAA`
    const res = await app.request('/', { headers: { cookie: `ggcookie=${tampered}` } })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('ggcookie=')
    const newRaw = setCookie!.split('ggcookie=')[1]!.split(';')[0]
    const body = (await res.json()) as { cookie: string }
    expect(body.cookie).not.toBe(uuid)
    expect(newRaw).toContain('.')
  })

  it('grace path: accepts a plain UUID cookie and re-signs it', async () => {
    const uuid = crypto.randomUUID()
    const store = makeFakeStore()
    await store.upsertCookie(uuid)
    const { app } = buildTestApp(store)
    const res = await app.request('/', { headers: { cookie: `ggcookie=${uuid}` } })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('ggcookie=')
    const newRaw = setCookie!.split('ggcookie=')[1]!.split(';')[0]
    expect(newRaw).toBe(signCookie(uuid, HMAC_KEY))
    const body = (await res.json()) as { cookie: string }
    expect(body.cookie).toBe(uuid)
  })

  it('malformed cookie triggers fresh issuance', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/', { headers: { cookie: 'ggcookie=garbage' } })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('ggcookie=')
  })
})
