import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateTwitterCard(scrape: ScrapeResult): SignalResult {
  const raw = scrape.structured.meta.twitterCard
  if (raw === undefined || raw.trim().length === 0) {
    return { name: 'twitter-card', pass: false, weight: SIGNAL_WEIGHT, detail: 'twitter:card meta is missing' }
  }
  return { name: 'twitter-card', pass: true, weight: SIGNAL_WEIGHT, detail: `twitter:card = "${raw.trim()}"` }
}
