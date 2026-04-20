import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

type Env = { Variables: { clientIp: string } }

function buildApp(opts: { trustedProxies: string[]; isProduction: boolean }) {
  const app = new Hono<Env>()
  app.use('*', clientIp(opts))
  app.get('/', (c) => c.json({ ip: c.var.clientIp }))
  return app
}

describe('clientIp — trusted-proxy enforcement', () => {
  it('production: ignores XFF when peer not in allow-list', async () => {
    const app = buildApp({ trustedProxies: ['10.0.0.0/8'], isProduction: true })
    const res = await app.request('/', {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        // no peer IP header → peer is empty → not in 10.0.0.0/8
      },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).not.toBe('1.2.3.4')
  })

  it('production: honors XFF when peer is in allow-list', async () => {
    const app = buildApp({ trustedProxies: ['10.0.0.0/8'], isProduction: true })
    const res = await app.request('/', {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '10.1.2.3',  // allow-listed peer
      },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('1.2.3.4')
  })

  it('development: honors XFF unconditionally (ergonomic testing)', async () => {
    const app = buildApp({ trustedProxies: [], isProduction: false })
    const res = await app.request('/', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('1.2.3.4')
  })
})
