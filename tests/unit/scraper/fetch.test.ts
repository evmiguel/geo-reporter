import { describe, expect, it, vi } from 'vitest'
import { fetchHtml, FetchError } from '../../../src/scraper/fetch.ts'

function fakeDeps(fetcher: (url: string, init: { signal: AbortSignal }) => Promise<Response>) {
  return {
    fetcher: fetcher as unknown as import('../../../src/scraper/safe-fetch.ts').FetchLike,
    resolveHost: vi.fn().mockResolvedValue(undefined),
  }
}

describe('fetchHtml', () => {
  it('returns html + finalUrl + contentType on 200', async () => {
    const deps = fakeDeps(async () => new Response('<html>ok</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))
    const got = await fetchHtml('https://example.com/', {}, deps)
    expect(got.html).toBe('<html>ok</html>')
    expect(got.contentType).toBe('text/html; charset=utf-8')
    expect(got.finalUrl).toBe('https://example.com/')
  })

  it('throws FetchError on non-2xx', async () => {
    const deps = fakeDeps(async () => new Response('nope', { status: 503 }))
    await expect(fetchHtml('https://example.com/', {}, deps)).rejects.toBeInstanceOf(FetchError)
  })

  it('throws FetchError when content-type is not html-ish', async () => {
    const deps = fakeDeps(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(fetchHtml('https://example.com/', {}, deps)).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'non-html-content-type',
    })
  })

  it('aborts after the configured timeout', async () => {
    const deps = fakeDeps((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))
    await expect(fetchHtml('https://example.com/', { timeoutMs: 20 }, deps)).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'timeout',
    })
  })
})
