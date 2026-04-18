import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const MIN_LENGTH = 50

export function evaluateDescription(scrape: ScrapeResult): SignalResult {
  const raw = scrape.structured.meta.description
  if (raw === undefined || raw.trim().length === 0) {
    return { name: 'description', pass: false, weight: SIGNAL_WEIGHT, detail: 'meta description is missing' }
  }
  const length = raw.trim().length
  if (length < MIN_LENGTH) {
    return {
      name: 'description',
      pass: false,
      weight: SIGNAL_WEIGHT,
      detail: `meta description is too short (${length} chars, need ≥ ${MIN_LENGTH})`,
    }
  }
  return { name: 'description', pass: true, weight: SIGNAL_WEIGHT, detail: `meta description is ${length} chars` }
}
