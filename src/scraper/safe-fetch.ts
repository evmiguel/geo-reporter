import { Agent, fetch as undiciFetch } from 'undici'
import { lookup as dnsLookup, type LookupOptions, type LookupAddress } from 'node:dns'
import { resolveSafeHost, isPrivateAddress, SSRFBlockedError } from './ssrf.ts'

// Callback shape matches node's net.LookupFunction: the 2nd arg is either a
// single address string (when the caller asked for one address) OR a
// LookupAddress[] (when the caller passed all:true). Undici's connect layer
// calls us with all:true and destructures the array — if we returned a
// single-address shape instead, it would crash with
// `Invalid IP address: undefined`, which is exactly what AmEx was hitting.
type SafeLookupCb = (
  err: NodeJS.ErrnoException | null,
  addressOrList: string | LookupAddress[],
  family?: number,
) => void
type SafeLookup = (hostname: string, options: LookupOptions, cb: SafeLookupCb) => void

/**
 * Socket-level DNS lookup that rejects private IPs. This is the ONLY layer that
 * survives DNS rebinding: resolve-then-fetch TOCTOU races can't beat this
 * because the lookup happens at connect time, and the IP we validate is the
 * IP we connect to.
 *
 * Exported as a factory so tests can substitute a fake DNS implementation.
 */
export function makeSafeLookup(
  dns: typeof dnsLookup = dnsLookup,
): SafeLookup {
  return (hostname, options, cb) => {
    const opts = typeof options === 'object' && options !== null ? options : {}
    // Always resolve ALL addresses so we can reject any-private (defense
    // against mixed record sets). Whether we hand the array or a single
    // address back to the caller depends on what THEY asked for.
    const wantArray = opts.all === true
    dns(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) { cb(err, '', 0); return }
      const list = (Array.isArray(addrs) ? addrs : []) as LookupAddress[]
      if (list.length === 0) {
        cb(new SSRFBlockedError(hostname, 'no-address'), '', 0)
        return
      }
      // Reject if ANY resolved address is private — mixed record sets are
      // a known rebinding shape.
      const privateHit = list.find((a) => isPrivateAddress(a.address))
      if (privateHit) {
        cb(new SSRFBlockedError(hostname, privateHit.address), '', 0)
        return
      }
      if (wantArray) {
        cb(null, list)
      } else {
        const pick = list[0]!
        cb(null, pick.address, pick.family)
      }
    })
  }
}

const safeAgent = new Agent({
  connect: {
    lookup: makeSafeLookup(),
  },
})

export interface SafeFetchOptions {
  timeoutMs?: number
  maxRedirects?: number
  headers?: Record<string, string>
  method?: string
}

type FetcherInit = {
  method?: string
  headers?: Record<string, string>
  redirect: 'manual'
  signal: AbortSignal
  dispatcher?: Agent
}

export type FetchLike = (url: string, init: FetcherInit) => Promise<Response>

export interface SafeFetchDeps {
  fetcher?: FetchLike
  resolveHost?: (hostname: string) => Promise<unknown>
}

async function defaultFetcher(url: string, init: FetcherInit): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: safeAgent }) as unknown as Promise<Response>
}

/**
 * fetch() wrapper that:
 *  - validates hostname before every hop (catches obvious public→private redirects),
 *  - routes all connections through safeAgent (catches DNS rebinding), and
 *  - follows redirects manually with a hard cap.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
  deps: SafeFetchDeps = {},
): Promise<Response> {
  const fetcher = deps.fetcher ?? defaultFetcher
  const resolveHost = deps.resolveHost ?? resolveSafeHost
  const maxRedirects = opts.maxRedirects ?? 5
  const timeoutMs = opts.timeoutMs ?? 10_000
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let current = url
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = new URL(current)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SSRFBlockedError(parsed.hostname, `bad-protocol:${parsed.protocol}`)
      }
      await resolveHost(parsed.hostname)

      const init: FetcherInit = {
        redirect: 'manual',
        signal: controller.signal,
        ...(opts.method !== undefined ? { method: opts.method } : {}),
        ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      }
      const res = await fetcher(current, init)

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return res
        current = new URL(loc, current).toString()
        continue
      }
      return res
    }
    throw new Error('too many redirects')
  } finally {
    clearTimeout(t)
  }
}
