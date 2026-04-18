import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const GENERIC_TITLES = new Set(['home', 'index', 'untitled', 'welcome', 'default'])

export function evaluateTitle(scrape: ScrapeResult): SignalResult {
  const raw = scrape.structured.meta.title
  if (raw === undefined || raw.trim().length === 0) {
    return { name: 'title', pass: false, weight: SIGNAL_WEIGHT, detail: '<title> is missing' }
  }
  const normalized = raw.trim().toLowerCase()
  if (GENERIC_TITLES.has(normalized)) {
    return { name: 'title', pass: false, weight: SIGNAL_WEIGHT, detail: `<title> is too generic: "${raw.trim()}"` }
  }
  return { name: 'title', pass: true, weight: SIGNAL_WEIGHT, detail: `<title> is "${raw.trim()}"` }
}
