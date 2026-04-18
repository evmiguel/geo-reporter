import type { ScrapeResult } from '../scraper/index.ts'
import type { ProviderId } from './providers/types.ts'

export interface GroundTruth {
  url: string
  domain: string
  title: string
  description: string
  h1: string
  bodyExcerpt: string
}

export interface ProbeForJudge {
  key: string
  provider: ProviderId
  category: 'coverage'
  prompt: string
  response: string
}

export function toGroundTruth(url: string, scrape: ScrapeResult): GroundTruth {
  const hostname = (() => {
    try { return new URL(url).hostname } catch { return url }
  })()
  const domain = hostname.toLowerCase().replace(/^www\./, '')
  const title = scrape.structured.meta.title ?? ''
  const description = scrape.structured.meta.description ?? ''
  const h1 = scrape.structured.headings.h1[0] ?? ''
  const bodyExcerpt = scrape.text.trim().slice(0, 2000)
  return { url, domain, title, description, h1, bodyExcerpt }
}

export function isSparseGroundTruth(gt: GroundTruth): boolean {
  const total = gt.description.length + gt.h1.length + gt.bodyExcerpt.length
  return total < 100
}
