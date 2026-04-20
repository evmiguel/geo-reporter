import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from '../../../src/scraper/render.ts'

const savedEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = savedEnv
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('render SSRF defense', () => {
  it('throws before launching Playwright when host resolves to a private IP (prod)', async () => {
    process.env.NODE_ENV = 'production'
    await expect(render('http://10.0.0.1/')).rejects.toThrow()
  })

  it('rejects cloud metadata IP in production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(render('http://169.254.169.254/')).rejects.toThrow()
  })
})
