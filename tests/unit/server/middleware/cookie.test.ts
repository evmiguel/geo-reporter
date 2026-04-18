import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'

describe('cookie middleware', () => {
  function buildTestApp(isProduction = false) {
    const store = makeFakeStore()
    const app = new Hono<{ Variables: { cookie: string } }>()
    app.use('*', cookieMiddleware(store, isProduction))
    app.get('/', (c) => c.json({ cookie: c.var.cookie }))
    return { app, store }
  }

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
    const { app } = buildTestApp(true)
    const res = await app.request('/')
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('Secure')
  })

  it('reuses an existing cookie and does not re-issue', async () => {
    const { app, store } = buildTestApp()
    const preset = '11111111-2222-3333-4444-555555555555'
    await store.upsertCookie(preset)
    const res = await app.request('/', { headers: { cookie: `ggcookie=${preset}` } })
    const body = (await res.json()) as { cookie: string }
    expect(body.cookie).toBe(preset)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(store.cookiesMap.size).toBe(1)   // no new rows
  })

  it('calls upsertCookie exactly once on issuance', async () => {
    const { app, store } = buildTestApp()
    await app.request('/')
    await app.request('/', { headers: { cookie: `ggcookie=${[...store.cookiesMap.keys()][0]}` } })
    // First request: upsertCookie called once (issuance).
    // Second request: cookie exists, no upsert.
    expect(store.cookiesMap.size).toBe(1)
  })
})
