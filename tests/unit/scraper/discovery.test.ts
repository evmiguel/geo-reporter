import { describe, expect, it, vi } from 'vitest'
import {
  fetchRobotsTxt,
  fetchSitemapStatus,
  fetchLlmsTxtStatus,
} from '../../../src/scraper/discovery.ts'
import { SSRFBlockedError } from '../../../src/scraper/ssrf.ts'
import type { FetchLike } from '../../../src/scraper/safe-fetch.ts'

function deps(handler: (url: string) => Response | Promise<Response>) {
  const fetcher = ((url: string) => Promise.resolve(handler(url))) as unknown as FetchLike
  return { fetcher, resolveHost: vi.fn().mockResolvedValue(undefined) }
}

describe('fetchRobotsTxt', () => {
  it('returns body on 200', async () => {
    const d = deps(() => new Response('User-agent: *\nAllow: /', { status: 200 }))
    expect(await fetchRobotsTxt('https://example.com', d)).toBe('User-agent: *\nAllow: /')
  })

  it('returns null on 404', async () => {
    const d = deps(() => new Response('', { status: 404 }))
    expect(await fetchRobotsTxt('https://example.com', d)).toBeNull()
  })

  it('returns null on network error', async () => {
    const d = deps(() => { throw new Error('refused') })
    expect(await fetchRobotsTxt('https://example.com', d)).toBeNull()
  })

  it('returns null on SSRF block (fails closed — never leaks internal /robots.txt)', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const resolveHost = vi.fn().mockRejectedValue(new SSRFBlockedError('10.0.0.1', '10.0.0.1'))
    expect(await fetchRobotsTxt('http://10.0.0.1', { fetcher, resolveHost })).toBeNull()
  })

  it('hits the origin with /robots.txt path', async () => {
    let seen = ''
    const d = deps((u) => { seen = u; return new Response('ok', { status: 200 }) })
    await fetchRobotsTxt('https://sub.example.com/deep/path?x=1', d)
    expect(seen).toBe('https://sub.example.com/robots.txt')
  })
})

describe('fetchSitemapStatus', () => {
  it('present=true on 200', async () => {
    const d = deps(() => new Response('<urlset/>', { status: 200 }))
    expect(await fetchSitemapStatus('https://example.com', d)).toEqual({
      present: true,
      url: 'https://example.com/sitemap.xml',
    })
  })

  it('present=false on 404', async () => {
    const d = deps(() => new Response('', { status: 404 }))
    expect(await fetchSitemapStatus('https://example.com', d)).toEqual({
      present: false,
      url: 'https://example.com/sitemap.xml',
    })
  })
})

describe('fetchLlmsTxtStatus', () => {
  it('present=true on 200', async () => {
    const d = deps(() => new Response('# About\n...', { status: 200 }))
    expect(await fetchLlmsTxtStatus('https://example.com', d)).toEqual({
      present: true,
      url: 'https://example.com/llms.txt',
    })
  })

  it('present=false on 404', async () => {
    const d = deps(() => new Response('', { status: 404 }))
    expect(await fetchLlmsTxtStatus('https://example.com', d)).toEqual({
      present: false,
      url: 'https://example.com/llms.txt',
    })
  })
})
