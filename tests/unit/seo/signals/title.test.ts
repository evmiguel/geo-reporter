import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateTitle } from '../../../../src/seo/signals/title.ts'

function makeScrape(title: string | undefined): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
      meta: title === undefined ? {} : { title },
    },
  }
}

describe('evaluateTitle', () => {
  it('passes for a specific, non-generic title', () => {
    const r = evaluateTitle(makeScrape('Acme Widgets — Industrial-Grade Sprockets'))
    expect(r).toMatchObject({ name: 'title', pass: true, weight: 10 })
  })

  it('fails when title is missing', () => {
    const r = evaluateTitle(makeScrape(undefined))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('missing')
  })

  it('fails for exact-match "Home" (case-insensitive)', () => {
    expect(evaluateTitle(makeScrape('Home')).pass).toBe(false)
    expect(evaluateTitle(makeScrape('home')).pass).toBe(false)
    expect(evaluateTitle(makeScrape('  HOME  ')).pass).toBe(false)
  })

  it('fails for other exact-match blacklist entries', () => {
    for (const generic of ['index', 'untitled', 'welcome', 'default']) {
      expect(evaluateTitle(makeScrape(generic)).pass).toBe(false)
    }
  })

  it('passes for titles that contain a generic word but are not equal to it', () => {
    expect(evaluateTitle(makeScrape('Home | Acme Widgets')).pass).toBe(true)
    expect(evaluateTitle(makeScrape('Welcome to Our Site')).pass).toBe(true)
  })
})
