import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateDescription } from '../../../../src/seo/signals/description.ts'

function makeScrape(description: string | undefined): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
      meta: description === undefined ? {} : { description },
    },
  }
}

describe('evaluateDescription', () => {
  it('passes when description is exactly 50 chars', () => {
    const r = evaluateDescription(makeScrape('x'.repeat(50)))
    expect(r.pass).toBe(true)
  })

  it('passes when description is longer than 50 chars', () => {
    const r = evaluateDescription(makeScrape('x'.repeat(120)))
    expect(r.pass).toBe(true)
  })

  it('fails when description is missing', () => {
    const r = evaluateDescription(makeScrape(undefined))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('missing')
  })

  it('fails when description is under 50 chars, and reports the length', () => {
    const r = evaluateDescription(makeScrape('x'.repeat(49)))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('49')
    expect(r.detail).toContain('50')
  })

  it('fails when description is only whitespace', () => {
    const r = evaluateDescription(makeScrape('                                                      '))
    expect(r.pass).toBe(false)
  })
})
