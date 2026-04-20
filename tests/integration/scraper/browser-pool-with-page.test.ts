import { describe, it, expect, afterAll } from 'vitest'
import { getBrowserPool, shutdownBrowserPool } from '../../../src/scraper/render.ts'

describe('BrowserPool.withPage', () => {
  afterAll(async () => { await shutdownBrowserPool() })

  it('runs a callback with a fresh page and closes it afterwards', async () => {
    const pool = getBrowserPool()
    const got = await pool.withPage(async (page) => {
      await page.setContent('<html><body><h1>hello</h1></body></html>')
      return await page.textContent('h1')
    })
    expect(got).toBe('hello')
  })
})
