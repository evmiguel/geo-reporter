import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchHtml, FetchError } from '../../../src/scraper/fetch.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockFetch(impl: typeof fetch): void {
  globalThis.fetch = impl as unknown as typeof fetch
}

describe('fetchHtml', () => {
  it('returns html + finalUrl + contentType on 200', async () => {
    mockFetch(async () => new Response('<html>ok</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))
    const got = await fetchHtml('https://example.com/')
    expect(got.html).toBe('<html>ok</html>')
    expect(got.contentType).toBe('text/html; charset=utf-8')
    expect(got.finalUrl).toBe('https://example.com/')
  })

  it('throws FetchError on non-2xx', async () => {
    mockFetch(async () => new Response('nope', { status: 503 }))
    await expect(fetchHtml('https://example.com/')).rejects.toBeInstanceOf(FetchError)
  })

  it('throws FetchError when content-type is not html-ish', async () => {
    mockFetch(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(fetchHtml('https://example.com/')).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'non-html-content-type',
    })
  })

  it('aborts after the configured timeout', async () => {
    mockFetch((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))
    await expect(fetchHtml('https://example.com/', { timeoutMs: 20 })).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'timeout',
    })
  })
})
