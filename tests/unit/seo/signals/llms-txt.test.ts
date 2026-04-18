import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateLlmsTxt } from '../../../../src/seo/signals/llms-txt.ts'

function makeScrape(present: boolean): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present, url: 'https://acme.example/llms.txt' },
    },
  }
}

describe('evaluateLlmsTxt', () => {
  it('passes when llms.txt is reachable', () => {
    expect(evaluateLlmsTxt(makeScrape(true)).pass).toBe(true)
  })
  it('fails when llms.txt is not reachable', () => {
    const r = evaluateLlmsTxt(makeScrape(false))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('llms.txt')
  })
})
