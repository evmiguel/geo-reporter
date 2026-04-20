import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchHtml } from '../../../src/scraper/fetch.ts'

const savedEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = savedEnv
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchHtml SSRF defense', () => {
  it('rejects http://10.0.0.1 in production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(fetchHtml('http://10.0.0.1/')).rejects.toThrow()
  })

  it('rejects http://169.254.169.254 (cloud metadata) in production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(fetchHtml('http://169.254.169.254/')).rejects.toThrow()
  })

  it('allows http://127.0.0.1 in development (bypass)', async () => {
    process.env.NODE_ENV = 'development'
    const stub = vi.fn(
      async () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    vi.stubGlobal('fetch', stub)
    const res = await fetchHtml('http://127.0.0.1/')
    expect(res.html).toBe('<html></html>')
  })
})
