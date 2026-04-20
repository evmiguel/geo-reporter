import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

describe('clientIp middleware', () => {
  function buildTestApp(): Hono<{ Variables: { clientIp: string } }> {
    const app = new Hono<{ Variables: { clientIp: string } }>()
    app.use('*', clientIp({ trustedProxies: [], isProduction: false }))
    app.get('/', (c) => c.json({ ip: c.var.clientIp }))
    return app
  }

  it('returns the X-Forwarded-For value when present', async () => {
    const app = buildTestApp()
    const res = await app.request('/', { headers: { 'x-forwarded-for': '203.0.113.5' } })
    expect(await res.json()).toEqual({ ip: '203.0.113.5' })
  })

  it('returns the first entry of a comma-separated X-Forwarded-For list', async () => {
    const app = buildTestApp()
    const res = await app.request('/', { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 192.168.1.1' } })
    expect(await res.json()).toEqual({ ip: '203.0.113.5' })
  })

  it('trims whitespace around the X-Forwarded-For value', async () => {
    const app = buildTestApp()
    const res = await app.request('/', { headers: { 'x-forwarded-for': '   203.0.113.5   , 10.0.0.1' } })
    expect(await res.json()).toEqual({ ip: '203.0.113.5' })
  })

  it('falls back to 0.0.0.0 when XFF is absent and no socket info is available', async () => {
    const app = buildTestApp()
    const res = await app.request('/')
    expect(await res.json()).toEqual({ ip: '0.0.0.0' })
  })
})
