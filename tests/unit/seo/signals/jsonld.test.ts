import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateJsonLd } from '../../../../src/seo/signals/jsonld.ts'

function makeScrape(jsonld: unknown[]): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld, og: {}, meta: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateJsonLd', () => {
  it('passes for a top-level @type: Organization', () => {
    const r = evaluateJsonLd(makeScrape([{ '@type': 'Organization', name: 'Acme' }]))
    expect(r).toMatchObject({ name: 'jsonld', pass: true, weight: 10 })
  })

  it('passes for @type: Product', () => {
    expect(evaluateJsonLd(makeScrape([{ '@type': 'Product' }])).pass).toBe(true)
  })

  it('passes for @type: WebSite', () => {
    expect(evaluateJsonLd(makeScrape([{ '@type': 'WebSite' }])).pass).toBe(true)
  })

  it('passes when @type is an array containing Organization', () => {
    expect(evaluateJsonLd(makeScrape([{ '@type': ['Thing', 'Organization'] }])).pass).toBe(true)
  })

  it('passes when Organization is nested inside @graph', () => {
    expect(evaluateJsonLd(makeScrape([{
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'BreadcrumbList' }, { '@type': 'Organization' }],
    }])).pass).toBe(true)
  })

  it('passes when one of multiple blocks is Organization', () => {
    expect(evaluateJsonLd(makeScrape([
      { '@type': 'BreadcrumbList' },
      { '@type': 'Organization' },
    ])).pass).toBe(true)
  })

  it('fails when jsonld array is empty', () => {
    const r = evaluateJsonLd(makeScrape([]))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('No JSON-LD')
  })

  it('fails when no @type matches the allowed set', () => {
    const r = evaluateJsonLd(makeScrape([{ '@type': 'Article' }, { '@type': 'BreadcrumbList' }]))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('Article')
  })

  it('fails gracefully on malformed block shapes', () => {
    const r = evaluateJsonLd(makeScrape(['just a string', 42, null, { noType: true }]))
    expect(r.pass).toBe(false)
  })
})
