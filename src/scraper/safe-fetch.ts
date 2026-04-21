import { Agent, fetch as undiciFetch } from 'undici'
import { lookup as dnsLookup, type LookupOptions } from 'node:dns'
import { resolveSafeHost, isPrivateAddress, SSRFBlockedError } from './ssrf.ts'

type SafeLookupCb = (err: NodeJS.ErrnoException | null, address: string, family: number) => void
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
    dns(hostname, { all: true, ...opts }, (err, addrs) => {
      if (err) { cb(err, '', 0); return }
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs as unknown as string, family: 4 }]
      for (const a of list) {
        if (isPrivateAddress(a.address)) {
          cb(new SSRFBlockedError(hostname, a.address), '', 0)
          return
        }
      }
      const pick = list[0]!
      cb(null, pick.address, pick.family)
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
