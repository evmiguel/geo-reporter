import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateHeadings(scrape: ScrapeResult): SignalResult {
  const { h1, h2 } = scrape.structured.headings
  if (h1.length === 0) {
    return { name: 'headings', pass: false, weight: SIGNAL_WEIGHT, detail: 'no <h1> present' }
  }
  if (h1.length > 1) {
    return { name: 'headings', pass: false, weight: SIGNAL_WEIGHT, detail: `multiple <h1> tags (${h1.length} found)` }
  }
  if (h2.length === 0) {
    return { name: 'headings', pass: false, weight: SIGNAL_WEIGHT, detail: 'no <h2> present' }
  }
  return {
    name: 'headings',
    pass: true,
    weight: SIGNAL_WEIGHT,
    detail: `1 <h1> and ${h2.length} <h2> tag${h2.length === 1 ? '' : 's'}`,
  }
}
