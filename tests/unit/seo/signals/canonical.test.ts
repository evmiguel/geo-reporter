import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateCanonical } from '../../../../src/seo/signals/canonical.ts'

function makeScrape(canonical: string | undefined): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
      meta: canonical === undefined ? {} : { canonical },
    },
  }
}

describe('evaluateCanonical', () => {
  it('passes when canonical link is present', () => {
    expect(evaluateCanonical(makeScrape('https://acme.example/')).pass).toBe(true)
  })

  it('fails when canonical link is missing', () => {
    const r = evaluateCanonical(makeScrape(undefined))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('missing')
  })
})
