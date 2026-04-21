import { describe, it, expect, vi } from 'vitest'
import { safeFetch, makeSafeLookup } from '../../../src/scraper/safe-fetch.ts'
import { SSRFBlockedError } from '../../../src/scraper/ssrf.ts'

function ok(body = ''): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

describe('safeFetch — protocol filter', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(SSRFBlockedError)
  })

  it('rejects ftp://', async () => {
    await expect(safeFetch('ftp://example.com/')).rejects.toThrow(SSRFBlockedError)
  })
})

describe('safeFetch — per-hop validation', () => {
  it('rejects up-front when hostname resolves to a private IP', async () => {
    const resolveHost = vi.fn().mockRejectedValue(new SSRFBlockedError('10.0.0.1', '10.0.0.1'))
    const fetcher = vi.fn()
    await expect(safeFetch('http://10.0.0.1/', {}, { resolveHost, fetcher })).rejects.toThrow(SSRFBlockedError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('follows 302 public → public redirect', async () => {
    const resolveHost = vi.fn().mockResolvedValue(undefined)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(redirect('https://final.example/'))
      .mockResolvedValueOnce(ok('<html>final</html>'))
    const res = await safeFetch('https://start.example/', {}, { resolveHost, fetcher })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>final</html>')
    expect(resolveHost).toHaveBeenCalledTimes(2)
    expect(resolveHost).toHaveBeenNthCalledWith(1, 'start.example')
    expect(resolveHost).toHaveBeenNthCalledWith(2, 'final.example')
  })

  it('rejects 302 that redirects to a private IP', async () => {
    const resolveHost = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SSRFBlockedError('10.0.0.5', '10.0.0.5'))
    const fetcher = vi.fn().mockResolvedValueOnce(redirect('http://10.0.0.5/'))
    await expect(safeFetch('https://public.example/', {}, { resolveHost, fetcher }))
      .rejects.toThrow(SSRFBlockedError)
  })

  it('returns response when 3xx has no Location header', async () => {
    const resolveHost = vi.fn().mockResolvedValue(undefined)
    const noLoc = new Response(null, { status: 304 })
    const fetcher = vi.fn().mockResolvedValueOnce(noLoc)
    const res = await safeFetch('https://example.com/', {}, { resolveHost, fetcher })
    expect(res.status).toBe(304)
  })

  it('caps at maxRedirects', async () => {
    const resolveHost = vi.fn().mockResolvedValue(undefined)
    const fetcher = vi.fn().mockImplementation(async () => redirect('https://next.example/'))
    await expect(
      safeFetch('https://a.example/', { maxRedirects: 2 }, { resolveHost, fetcher }),
    ).rejects.toThrow(/too many redirects/i)
    // Initial + 2 redirects = 3 calls, then we give up on the 4th
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})

type DnsCb = (err: NodeJS.ErrnoException | null, addrs: { address: string; family: number }[]) => void
type LookupArgs = [string, unknown, DnsCb]
type LookupCb = (err: Error | null, addr: string, family: number) => void

function invokeLookup(
  fakeDns: (...args: LookupArgs) => void,
  hostname: string,
): Promise<{ err: Error | null; addr: string; family: number }> {
  const lookup = makeSafeLookup(fakeDns as unknown as typeof import('node:dns').lookup)
  return new Promise((resolve) => {
    const cb: LookupCb = (err, addr, family) => { resolve({ err, addr, family }) }
    // @ts-expect-error undici socket lookup signature is (err, addr, family)
    lookup(hostname, {}, cb)
  })
}

describe('makeSafeLookup — DNS rebinding defense', () => {
  it('returns the first public address', async () => {
    const fakeDns = (...args: LookupArgs) => {
      args[2](null, [{ address: '1.2.3.4', family: 4 }])
    }
    const { err, addr, family } = await invokeLookup(fakeDns, 'legit.example')
    expect(err).toBeNull()
    expect(addr).toBe('1.2.3.4')
    expect(family).toBe(4)
  })

  it('rejects any resolved address that is private', async () => {
    const fakeDns = (...args: LookupArgs) => {
      args[2](null, [{ address: '10.0.0.5', family: 4 }])
    }
    const { err } = await invokeLookup(fakeDns, 'rebind.example')
    expect(err).toBeInstanceOf(SSRFBlockedError)
  })

  it('rejects when ANY resolved address is private (defense vs. mixed record sets)', async () => {
    const fakeDns = (...args: LookupArgs) => {
      args[2](null, [{ address: '1.2.3.4', family: 4 }, { address: '127.0.0.1', family: 4 }])
    }
    const { err } = await invokeLookup(fakeDns, 'mixed.example')
    expect(err).toBeInstanceOf(SSRFBlockedError)
  })

  it('propagates DNS errors', async () => {
    const fakeDns = (...args: LookupArgs) => {
      const e = new Error('ENOTFOUND') as NodeJS.ErrnoException
      e.code = 'ENOTFOUND'
      args[2](e, [])
    }
    const { err } = await invokeLookup(fakeDns, 'nxdomain.example')
    expect(err).toBeTruthy()
    expect((err as NodeJS.ErrnoException).code).toBe('ENOTFOUND')
  })
})
