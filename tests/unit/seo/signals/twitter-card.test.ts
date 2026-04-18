import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateTwitterCard } from '../../../../src/seo/signals/twitter-card.ts'

function makeScrape(twitterCard: string | undefined): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
      meta: twitterCard === undefined ? {} : { twitterCard },
    },
  }
}

describe('evaluateTwitterCard', () => {
  it('passes when twitter:card is present (summary)', () => {
    expect(evaluateTwitterCard(makeScrape('summary')).pass).toBe(true)
  })

  it('passes for summary_large_image', () => {
    expect(evaluateTwitterCard(makeScrape('summary_large_image')).pass).toBe(true)
  })

  it('fails when twitter:card is missing', () => {
    const r = evaluateTwitterCard(makeScrape(undefined))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('twitter:card')
  })
})
