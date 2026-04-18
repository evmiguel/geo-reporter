import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateSitemap } from '../../../../src/seo/signals/sitemap.ts'

function makeScrape(present: boolean): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present, url: 'https://acme.example/sitemap.xml' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateSitemap', () => {
  it('passes when sitemap.xml is reachable', () => {
    expect(evaluateSitemap(makeScrape(true)).pass).toBe(true)
  })
  it('fails when sitemap.xml is not reachable', () => {
    const r = evaluateSitemap(makeScrape(false))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('sitemap.xml')
  })
})
