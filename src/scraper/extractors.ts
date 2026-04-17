import * as cheerio from 'cheerio'
import type { OpenGraph, MetaData, Headings } from './types.ts'

export function extractJsonLd(html: string): unknown[] {
  const $ = cheerio.load(html)
  const out: unknown[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim()
    if (!raw) return
    try {
      out.push(JSON.parse(raw))
    } catch {
      // Drop malformed blocks silently — real sites ship broken JSON-LD regularly.
    }
  })
  return out
}

export function extractOpenGraph(html: string): OpenGraph {
  const $ = cheerio.load(html)
  const pick = (prop: string): string | undefined => {
    const v = $(`meta[property="og:${prop}"]`).attr('content')?.trim()
    return v && v.length > 0 ? v : undefined
  }
  const out: OpenGraph = {}
  const title = pick('title')
  const description = pick('description')
  const image = pick('image')
  const type = pick('type')
  const url = pick('url')
  if (title !== undefined) out.title = title
  if (description !== undefined) out.description = description
  if (image !== undefined) out.image = image
  if (type !== undefined) out.type = type
  if (url !== undefined) out.url = url
  return out
}

export function extractMeta(html: string): MetaData {
  const $ = cheerio.load(html)
  const attr = (sel: string): string | undefined => {
    const v = $(sel).attr('content')?.trim()
    return v && v.length > 0 ? v : undefined
  }
  const out: MetaData = {}
  const title = $('head > title').first().text().trim()
  if (title.length > 0) out.title = title
  const description = attr('meta[name="description"]')
  if (description !== undefined) out.description = description
  const canonical = $('link[rel="canonical"]').attr('href')?.trim()
  if (canonical && canonical.length > 0) out.canonical = canonical
  const twitterCard = attr('meta[name="twitter:card"]')
  if (twitterCard !== undefined) out.twitterCard = twitterCard
  const viewport = attr('meta[name="viewport"]')
  if (viewport !== undefined) out.viewport = viewport
  return out
}

export function extractHeadings(html: string): Headings {
  const $ = cheerio.load(html)
  const collect = (sel: string): string[] => {
    const arr: string[] = []
    $(sel).each((_, el) => {
      const t = $(el).text().trim()
      if (t.length > 0) arr.push(t)
    })
    return arr
  }
  return { h1: collect('h1'), h2: collect('h2') }
}
