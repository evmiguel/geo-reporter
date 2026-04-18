import { describe, it, expect } from 'vitest'
import type { ScrapeResult, OpenGraph } from '../../../../src/scraper/index.ts'
import { evaluateOpenGraph } from '../../../../src/seo/signals/open-graph.ts'

function makeScrape(og: OpenGraph): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og, meta: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateOpenGraph', () => {
  it('passes when title, description, and image are all present', () => {
    const r = evaluateOpenGraph(makeScrape({
      title: 'Acme',
      description: 'Things we make',
      image: 'https://img.example/og.png',
    }))
    expect(r).toMatchObject({ name: 'open-graph', pass: true, weight: 10 })
  })

  it('fails and names the missing fields when some are absent', () => {
    const r = evaluateOpenGraph(makeScrape({ title: 'Acme' }))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('og:description')
    expect(r.detail).toContain('og:image')
    expect(r.detail).not.toContain('og:title')
  })

  it('fails and lists all three when none are present', () => {
    const r = evaluateOpenGraph(makeScrape({}))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('og:title')
    expect(r.detail).toContain('og:description')
    expect(r.detail).toContain('og:image')
  })

  it('treats empty-string values as missing', () => {
    const r = evaluateOpenGraph(makeScrape({
      title: '',
      description: '',
      image: '',
    }))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('og:title')
  })
})
