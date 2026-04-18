import type { MiddlewareHandler } from 'hono'

type Env = { Variables: { clientIp: string } }

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } }
}

export function clientIp(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const xff = c.req.header('x-forwarded-for')
    const fromXff = xff?.split(',')[0]?.trim()
    const fromSocket = (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress
    const ip = fromXff || fromSocket || '0.0.0.0'
    c.set('clientIp', ip)
    await next()
  }
}
