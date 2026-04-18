import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateHeadings } from '../../../../src/seo/signals/headings.ts'

function makeScrape(h1: string[], h2: string[]): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, meta: {}, headings: { h1, h2 },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateHeadings', () => {
  it('passes with exactly one h1 and at least one h2', () => {
    expect(evaluateHeadings(makeScrape(['Main'], ['A'])).pass).toBe(true)
    expect(evaluateHeadings(makeScrape(['Main'], ['A', 'B', 'C'])).pass).toBe(true)
  })
  it('fails when no h1 is present', () => {
    const r = evaluateHeadings(makeScrape([], ['A']))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('<h1>')
  })
  it('fails when multiple h1 tags are present', () => {
    const r = evaluateHeadings(makeScrape(['A', 'B'], ['C']))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('2')
  })
  it('fails when no h2 is present', () => {
    const r = evaluateHeadings(makeScrape(['Main'], []))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('<h2>')
  })
})
