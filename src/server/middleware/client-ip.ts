import type { MiddlewareHandler } from 'hono'

type Env = { Variables: { clientIp: string } }

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } }
}

interface ClientIpOptions {
  isProduction: boolean
}

export function clientIp(opts: ClientIpOptions): MiddlewareHandler<Env> {
  return async (c, next) => {
    const fromSocket = (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress ?? ''
    const xff = c.req.header('x-forwarded-for')
    const entries = xff?.split(',').map((s) => s.trim()).filter(Boolean) ?? []

    if (opts.isProduction) {
      // Railway's edge appends the real client IP as the rightmost XFF entry,
      // so it's authoritative regardless of what a client injected upstream.
      // Railway doesn't publish edge CIDRs, so a trusted-proxy allow-list
      // isn't workable; rightmost-of-XFF is the pattern they recommend.
      // x-real-ip is deliberately NOT a fallback — a direct-to-container
      // request (bypassing the edge) could spoof it.
      const ip = entries.at(-1) ?? fromSocket ?? '0.0.0.0'
      c.set('clientIp', ip || '0.0.0.0')
    } else {
      // Dev/test: no real proxy in front. XFF is whatever the test set, so
      // use leftmost (original-client semantics). x-real-ip fallback kept
      // for ergonomic testing of routes that consult it directly.
      const realIp = c.req.header('x-real-ip') ?? ''
      const ip = entries[0] || realIp || fromSocket || '0.0.0.0'
      c.set('clientIp', ip)
    }
    await next()
  }
}
