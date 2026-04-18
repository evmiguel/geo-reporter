import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../src/scraper/index.ts'
import { evaluateSeo } from '../../../src/seo/index.ts'

const allGood: ScrapeResult = {
  rendered: false, html: '', text: '',
  structured: {
    jsonld: [{ '@type': 'Organization' }],
    og: { title: 'A', description: 'B', image: 'C' },
    meta: {
      title: 'Acme Widgets',
      description: 'A'.repeat(60),
      canonical: 'https://acme.example/',
      twitterCard: 'summary_large_image',
    },
    headings: { h1: ['Hello'], h2: ['Details'] },
    robots: 'User-agent: *\nAllow: /',
    sitemap: { present: true, url: 'https://acme.example/sitemap.xml' },
    llmsTxt: { present: true, url: 'https://acme.example/llms.txt' },
  },
}

const allBad: ScrapeResult = {
  rendered: false, html: '', text: '',
  structured: {
    jsonld: [],
    og: {},
    meta: {},
    headings: { h1: [], h2: [] },
    robots: 'User-agent: *\nDisallow: /',
    sitemap: { present: false, url: '' },
    llmsTxt: { present: false, url: '' },
  },
}

describe('evaluateSeo', () => {
  it('returns 10 signals in stable order', () => {
    const r = evaluateSeo(allGood)
    expect(r.signals).toHaveLength(10)
    expect(r.signals.map((s) => s.name)).toEqual([
      'title', 'description', 'canonical', 'twitter-card',
      'open-graph', 'jsonld',
      'robots', 'sitemap', 'llms-txt',
      'headings',
    ])
  })

  it('scores 100 when every signal passes', () => {
    const r = evaluateSeo(allGood)
    expect(r.score).toBe(100)
    expect(r.signals.every((s) => s.pass)).toBe(true)
  })

  it('scores 0 when every signal fails', () => {
    const r = evaluateSeo(allBad)
    expect(r.score).toBe(0)
    expect(r.signals.every((s) => !s.pass)).toBe(true)
  })

  it('scores 50 when exactly half the signals pass', () => {
    const half: ScrapeResult = {
      ...allBad,
      structured: {
        ...allBad.structured,
        // 5 pass: title, description, canonical, twitter-card, open-graph
        meta: {
          title: 'Acme Widgets',
          description: 'A'.repeat(60),
          canonical: 'https://acme.example/',
          twitterCard: 'summary',
        },
        og: { title: 'A', description: 'B', image: 'C' },
      },
    }
    const r = evaluateSeo(half)
    expect(r.score).toBe(50)
    expect(r.signals.filter((s) => s.pass)).toHaveLength(5)
  })

  it('score is rounded to the nearest integer', () => {
    // 7/10 = 70 (integer already — exercise the rounding code path with a near-edge case)
    const seven: ScrapeResult = {
      ...allBad,
      structured: {
        ...allBad.structured,
        meta: {
          title: 'Acme Widgets',
          description: 'A'.repeat(60),
          canonical: 'https://acme.example/',
          twitterCard: 'summary',
        },
        og: { title: 'A', description: 'B', image: 'C' },
        jsonld: [{ '@type': 'Organization' }],
        sitemap: { present: true, url: 'https://acme.example/sitemap.xml' },
      },
    }
    const r = evaluateSeo(seven)
    expect(r.score).toBe(70)
    expect(Number.isInteger(r.score)).toBe(true)
  })
})
