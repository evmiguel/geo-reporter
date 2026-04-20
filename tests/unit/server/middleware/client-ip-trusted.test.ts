import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

type Env = { Variables: { clientIp: string } }

function buildApp(opts: { trustedProxies: string[]; isProduction: boolean }, socketAddr?: string) {
  const app = new Hono<Env>()
  // Inject a fake node-server env binding so tests can exercise the
  // socket-remote-address path without spinning up an HTTP server.
  app.use('*', async (c, next) => {
    if (socketAddr !== undefined) {
      ;(c as unknown as { env: unknown }).env = { incoming: { socket: { remoteAddress: socketAddr } } }
    }
    await next()
  })
  app.use('*', clientIp(opts))
  app.get('/', (c) => c.json({ ip: c.var.clientIp }))
  return app
}

describe('clientIp — trusted-proxy enforcement', () => {
  it('production: ignores XFF when socket peer not in allow-list', async () => {
    const app = buildApp({ trustedProxies: ['10.0.0.0/8'], isProduction: true }, '203.0.113.5')
    const res = await app.request('/', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).not.toBe('1.2.3.4')
  })

  it('production: honors XFF when SOCKET peer is in allow-list', async () => {
    const app = buildApp({ trustedProxies: ['10.0.0.0/8'], isProduction: true }, '10.1.2.3')
    const res = await app.request('/', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('1.2.3.4')
  })

  it('production: rejects spoofed x-real-ip claiming trusted peer', async () => {
    // Regression guard. A client outside the trusted CIDR must not be able to
    // promote itself into the allow-list by setting x-real-ip. The trust
    // decision MUST come from the kernel socket.
    const app = buildApp({ trustedProxies: ['10.0.0.0/8'], isProduction: true }, '203.0.113.99')
    const res = await app.request('/', {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '10.1.2.3',   // attacker-controlled header
      },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).not.toBe('1.2.3.4')
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
