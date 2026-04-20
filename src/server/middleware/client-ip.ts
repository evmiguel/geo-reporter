import type { MiddlewareHandler } from 'hono'

type Env = { Variables: { clientIp: string } }

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } }
}

interface ClientIpOptions {
  trustedProxies: string[]   // CIDR list; empty = trust nothing in prod
  isProduction: boolean
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function inCidr(addr: string, cidr: string): boolean {
  const [netStr, prefixStr] = cidr.split('/')
  const prefix = Number(prefixStr)
  if (netStr === undefined) return false
  const net = ipv4ToInt(netStr)
  const n = ipv4ToInt(addr)
  if (net === null || n === null || Number.isNaN(prefix)) return false
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (n & mask) === (net & mask)
}

function trustedPeer(peer: string, cidrs: string[]): boolean {
  return cidrs.some((c) => inCidr(peer, c))
}

export function clientIp(opts: ClientIpOptions): MiddlewareHandler<Env> {
  return async (c, next) => {
    const realIp = c.req.header('x-real-ip') ?? ''
    const fromSocket = (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress ?? ''
    const peer = realIp || fromSocket
    const xff = c.req.header('x-forwarded-for')
    const honorXff =
      xff !== undefined
      && (!opts.isProduction || trustedPeer(peer, opts.trustedProxies))
    const fromXff = honorXff ? xff.split(',')[0]?.trim() : undefined
    const ip = fromXff || peer || '0.0.0.0'
    c.set('clientIp', ip)
    await next()
  }
}
