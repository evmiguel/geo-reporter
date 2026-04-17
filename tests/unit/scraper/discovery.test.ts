import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchRobotsTxt,
  fetchSitemapStatus,
  fetchLlmsTxtStatus,
} from '../../../src/scraper/discovery.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return handler(url)
  }) as unknown as typeof fetch
}

describe('fetchRobotsTxt', () => {
  it('returns body on 200', async () => {
    stubFetch(() => new Response('User-agent: *\nAllow: /', { status: 200 }))
    expect(await fetchRobotsTxt('https://example.com')).toBe('User-agent: *\nAllow: /')
  })

  it('returns null on 404', async () => {
    stubFetch(() => new Response('', { status: 404 }))
    expect(await fetchRobotsTxt('https://example.com')).toBeNull()
  })

  it('returns null on network error', async () => {
    stubFetch(() => { throw new Error('refused') })
    expect(await fetchRobotsTxt('https://example.com')).toBeNull()
  })

  it('hits the origin with /robots.txt path', async () => {
    let seen = ''
    stubFetch((u) => { seen = u; return new Response('ok', { status: 200 }) })
    await fetchRobotsTxt('https://sub.example.com/deep/path?x=1')
    expect(seen).toBe('https://sub.example.com/robots.txt')
  })
})

describe('fetchSitemapStatus', () => {
  it('present=true on 200', async () => {
    stubFetch(() => new Response('<urlset/>', { status: 200 }))
    expect(await fetchSitemapStatus('https://example.com')).toEqual({
      present: true,
      url: 'https://example.com/sitemap.xml',
    })
  })

  it('present=false on 404', async () => {
    stubFetch(() => new Response('', { status: 404 }))
    expect(await fetchSitemapStatus('https://example.com')).toEqual({
      present: false,
      url: 'https://example.com/sitemap.xml',
    })
  })
})

describe('fetchLlmsTxtStatus', () => {
  it('present=true on 200', async () => {
    stubFetch(() => new Response('# About\n...', { status: 200 }))
    expect(await fetchLlmsTxtStatus('https://example.com')).toEqual({
      present: true,
      url: 'https://example.com/llms.txt',
    })
  })

  it('present=false on 404', async () => {
    stubFetch(() => new Response('', { status: 404 }))
    expect(await fetchLlmsTxtStatus('https://example.com')).toEqual({
      present: false,
      url: 'https://example.com/llms.txt',
    })
  })
})
