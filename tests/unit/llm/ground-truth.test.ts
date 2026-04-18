import { describe, expect, it } from 'vitest'
import { toGroundTruth, isSparseGroundTruth } from '../../../src/llm/ground-truth.ts'
import type { ScrapeResult } from '../../../src/scraper/index.ts'

function makeScrape(overrides: Partial<ScrapeResult> = {}): ScrapeResult {
  const base: ScrapeResult = {
    rendered: false,
    html: '<html></html>',
    text: 'body text here',
    structured: {
      jsonld: [],
      og: {},
      meta: { title: 'Acme', description: 'We sell widgets' },
      headings: { h1: ['Welcome'], h2: [] },
      robots: null,
      sitemap: { present: false, url: 'https://acme.com/sitemap.xml' },
      llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
    },
  }
  return { ...base, ...overrides }
}

describe('toGroundTruth', () => {
  it('extracts title, description, h1, bodyExcerpt from the scrape', () => {
    const gt = toGroundTruth('https://acme.com/', makeScrape())
    expect(gt.title).toBe('Acme')
    expect(gt.description).toBe('We sell widgets')
    expect(gt.h1).toBe('Welcome')
    expect(gt.bodyExcerpt).toBe('body text here')
  })

  it('lowercases and strips leading www. from domain', () => {
    const gt = toGroundTruth('https://WWW.Acme.COM/page', makeScrape())
    expect(gt.domain).toBe('acme.com')
    expect(gt.url).toBe('https://WWW.Acme.COM/page')
  })

  it('truncates bodyExcerpt to 2000 chars (trimmed)', () => {
    const long = 'x'.repeat(3000)
    const gt = toGroundTruth('https://a.com', makeScrape({ text: `   ${long}   ` }))
    expect(gt.bodyExcerpt.length).toBe(2000)
  })

  it('returns empty strings for missing title/description/h1', () => {
    const gt = toGroundTruth('https://a.com', makeScrape({
      structured: {
        jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] },
        robots: null,
        sitemap: { present: false, url: '' }, llmsTxt: { present: false, url: '' },
      },
    }))
    expect(gt.title).toBe('')
    expect(gt.description).toBe('')
    expect(gt.h1).toBe('')
  })
})

describe('isSparseGroundTruth', () => {
  it('returns true when description + h1 + bodyExcerpt sum < 100 chars', () => {
    expect(isSparseGroundTruth({
      url: 'https://a.com', domain: 'a.com',
      title: 'A', description: 'short', h1: 'x', bodyExcerpt: 'y',
    })).toBe(true)
  })

  it('returns false when total >= 100 chars', () => {
    expect(isSparseGroundTruth({
      url: 'https://a.com', domain: 'a.com',
      title: 'A', description: 'x'.repeat(50), h1: 'y'.repeat(25), bodyExcerpt: 'z'.repeat(25),
    })).toBe(false)
  })
})
