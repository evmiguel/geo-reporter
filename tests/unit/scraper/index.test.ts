import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// All mocks must be set up BEFORE importing the module under test.
vi.mock('../../../src/scraper/fetch.ts', () => ({
  fetchHtml: vi.fn(),
  FetchError: class FetchError extends Error {
    constructor(msg: string, public reason: string) { super(msg) }
  },
}))
vi.mock('../../../src/scraper/render.ts', () => ({
  render: vi.fn(),
}))
vi.mock('../../../src/scraper/discovery.ts', () => ({
  fetchRobotsTxt: vi.fn(async () => null),
  fetchSitemapStatus: vi.fn(async () => ({ present: false, url: 'https://e/sitemap.xml' })),
  fetchLlmsTxtStatus: vi.fn(async () => ({ present: false, url: 'https://e/llms.txt' })),
}))

const { fetchHtml } = await import('../../../src/scraper/fetch.ts')
const { render } = await import('../../../src/scraper/render.ts')
const { scrape } = await import('../../../src/scraper/index.ts')

const richHtml = `
  <html><head><title>A</title></head>
  <body>${'word '.repeat(400)}</body></html>`

const sparseHtml = `<html><head><title>SPA</title></head><body><div id="root"></div></body></html>`

beforeEach(() => {
  vi.mocked(fetchHtml).mockReset()
  vi.mocked(render).mockReset()
})

afterEach(() => vi.restoreAllMocks())

describe('scrape', () => {
  it('skips render when static HTML already has >=1000 chars of visible text', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({ html: richHtml, finalUrl: 'https://e/', contentType: 'text/html' })
    const r = await scrape('https://e/')
    expect(r.rendered).toBe(false)
    expect(r.text.length).toBeGreaterThanOrEqual(1000)
    expect(render).not.toHaveBeenCalled()
  })

  it('falls back to Playwright when static text is too thin', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({ html: sparseHtml, finalUrl: 'https://e/', contentType: 'text/html' })
    vi.mocked(render).mockResolvedValue({ html: richHtml, finalUrl: 'https://e/' })
    const r = await scrape('https://e/')
    expect(r.rendered).toBe(true)
    expect(r.text.length).toBeGreaterThanOrEqual(1000)
    expect(render).toHaveBeenCalledOnce()
  })

  it('falls back to Playwright when static fetch fails outright', async () => {
    vi.mocked(fetchHtml).mockRejectedValue(new Error('boom'))
    vi.mocked(render).mockResolvedValue({ html: richHtml, finalUrl: 'https://e/' })
    const r = await scrape('https://e/')
    expect(r.rendered).toBe(true)
    expect(render).toHaveBeenCalledOnce()
  })

  it('keeps static result if render also fails', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({ html: sparseHtml, finalUrl: 'https://e/', contentType: 'text/html' })
    vi.mocked(render).mockRejectedValue(new Error('render-boom'))
    const r = await scrape('https://e/')
    expect(r.rendered).toBe(false)
    expect(r.html).toBe(sparseHtml)
  })

  it('throws when BOTH static fetch and render fail', async () => {
    vi.mocked(fetchHtml).mockRejectedValue(new Error('boom1'))
    vi.mocked(render).mockRejectedValue(new Error('boom2'))
    await expect(scrape('https://e/')).rejects.toThrow()
  })
})
