import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'

export class SSRFBlockedError extends Error {
  constructor(readonly host: string, readonly address: string) {
    super(`SSRF block: ${host} resolved to private/local address ${address}`)
    this.name = 'SSRFBlockedError'
  }
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function inRange(addrInt: number, startStr: string, endStr: string): boolean {
  const s = ipv4ToInt(startStr)!
  const e = ipv4ToInt(endStr)!
  return addrInt >= s && addrInt <= e
}

function isPrivateIPv4(addr: string): boolean {
  const n = ipv4ToInt(addr)
  if (n === null) return false
  return (
    inRange(n, '10.0.0.0', '10.255.255.255') ||
    inRange(n, '172.16.0.0', '172.31.255.255') ||
    inRange(n, '192.168.0.0', '192.168.255.255') ||
    inRange(n, '127.0.0.0', '127.255.255.255') ||
    inRange(n, '169.254.0.0', '169.254.255.255') ||
    inRange(n, '100.64.0.0', '100.127.255.255') ||
    inRange(n, '0.0.0.0', '0.255.255.255') ||
    inRange(n, '224.0.0.0', '239.255.255.255')
  )
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase()
  return (
    lower === '::1' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('ff')
  )
}

export function isPrivateAddress(addr: string): boolean {
  return addr.includes(':') ? isPrivateIPv6(addr) : isPrivateIPv4(addr)
}

export async function resolveSafeHost(host: string): Promise<LookupAddress> {
  const addrs = await lookup(host, { all: true })
  if (addrs.length === 0) throw new SSRFBlockedError(host, 'no-address')
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new SSRFBlockedError(host, a.address)
  }
  return addrs[0]!
}
