import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateCanonical(scrape: ScrapeResult): SignalResult {
  const raw = scrape.structured.meta.canonical
  if (raw === undefined || raw.trim().length === 0) {
    return { name: 'canonical', pass: false, weight: SIGNAL_WEIGHT, detail: '<link rel="canonical"> is missing' }
  }
  return { name: 'canonical', pass: true, weight: SIGNAL_WEIGHT, detail: `canonical → ${raw.trim()}` }
}
