import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  extractJsonLd,
  extractOpenGraph,
  extractMeta,
  extractHeadings,
} from '../../../src/scraper/extractors.ts'

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')

describe('extractJsonLd', () => {
  it('parses a single JSON-LD block', () => {
    const blocks = extractJsonLd(fixture('rich.html'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ '@type': 'Organization', name: 'Acme Widgets' })
  })

  it('returns all valid blocks and silently drops malformed JSON', () => {
    const blocks = extractJsonLd(fixture('jsonld-multi.html'))
    expect(blocks).toHaveLength(2)
    expect((blocks[0] as Record<string, unknown>)['@type']).toBe('Organization')
    expect((blocks[1] as Record<string, unknown>)['@type']).toBe('WebSite')
  })

  it('returns empty array when no JSON-LD scripts exist', () => {
    expect(extractJsonLd(fixture('og-missing.html'))).toEqual([])
  })
})

describe('extractOpenGraph', () => {
  it('reads all og:* properties from the rich fixture', () => {
    expect(extractOpenGraph(fixture('rich.html'))).toEqual({
      title: 'Acme Widgets',
      description: 'Precision sprockets since 1923.',
      image: 'https://acme.example/og.png',
      type: 'website',
      url: 'https://acme.example/',
    })
  })

  it('returns an empty object (no keys) when no og tags are present', () => {
    expect(extractOpenGraph(fixture('og-missing.html'))).toEqual({})
  })
})

describe('extractMeta', () => {
  it('reads title, description, canonical, twitter card, viewport', () => {
    expect(extractMeta(fixture('rich.html'))).toEqual({
      title: 'Acme Widgets — Industrial-Grade Sprockets',
      description: expect.stringContaining('since 1923'),
      canonical: 'https://acme.example/',
      twitterCard: 'summary_large_image',
      viewport: 'width=device-width, initial-scale=1',
    })
  })

  it('returns only the fields that are present', () => {
    const meta = extractMeta(fixture('og-missing.html'))
    expect(meta.title).toBe('Basic Page')
    expect(meta.description).toBe('A plain page with no Open Graph tags.')
    expect(meta.canonical).toBeUndefined()
    expect(meta.twitterCard).toBeUndefined()
  })
})

describe('extractHeadings', () => {
  it('collects every h1 and h2 in document order, trimmed', () => {
    expect(extractHeadings(fixture('rich.html'))).toEqual({
      h1: ['Industrial-Grade Sprockets'],
      h2: ['Why Acme', 'Clients', 'Facilities'],
    })
  })

  it('returns empty arrays when no headings exist', () => {
    expect(extractHeadings(fixture('empty.html'))).toEqual({ h1: [], h2: [] })
  })
})
