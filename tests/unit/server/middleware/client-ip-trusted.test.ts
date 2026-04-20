import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

type Env = { Variables: { clientIp: string } }

function buildApp(opts: { isProduction: boolean }, socketAddr?: string) {
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

describe('clientIp — production (rightmost-XFF)', () => {
  it('uses the rightmost XFF value (Railway edge appends it)', async () => {
    // A client injected `evil` upstream, the edge appended the real client IP.
    // Rightmost wins regardless of what the client sent.
    const app = buildApp({ isProduction: true })
    const res = await app.request('/', {
      headers: { 'x-forwarded-for': 'evil, 1.2.3.4, 203.0.113.5' },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('203.0.113.5')
  })

  it('handles a single-value XFF', async () => {
    const app = buildApp({ isProduction: true })
    const res = await app.request('/', {
      headers: { 'x-forwarded-for': '203.0.113.5' },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('203.0.113.5')
  })

  it('falls back to socket peer when XFF is absent', async () => {
    const app = buildApp({ isProduction: true }, '203.0.113.99')
    const res = await app.request('/')
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('203.0.113.99')
  })

  it('ignores spoofed x-real-ip in production', async () => {
    // x-real-ip is a client-controllable header if the request bypasses
    // Railway's edge. Production must only consult XFF or socket peer.
    const app = buildApp({ isProduction: true }, '203.0.113.99')
    const res = await app.request('/', {
      headers: { 'x-real-ip': '10.0.0.1' },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('203.0.113.99')
    expect(body.ip).not.toBe('10.0.0.1')
  })

  it('development: honors leftmost XFF for ergonomic testing', async () => {
    const app = buildApp({ isProduction: false })
    const res = await app.request('/', {
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('1.2.3.4')
  })
})
