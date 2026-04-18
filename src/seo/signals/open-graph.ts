import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const REQUIRED: Array<{ key: 'title' | 'description' | 'image'; label: string }> = [
  { key: 'title', label: 'og:title' },
  { key: 'description', label: 'og:description' },
  { key: 'image', label: 'og:image' },
]

export function evaluateOpenGraph(scrape: ScrapeResult): SignalResult {
  const og = scrape.structured.og
  const missing: string[] = []
  for (const { key, label } of REQUIRED) {
    const v = og[key]
    if (!v || v.trim().length === 0) missing.push(label)
  }
  if (missing.length === 0) {
    return { name: 'open-graph', pass: true, weight: SIGNAL_WEIGHT, detail: 'og:title, og:description, og:image all present' }
  }
  return {
    name: 'open-graph',
    pass: false,
    weight: SIGNAL_WEIGHT,
    detail: `missing: ${missing.join(', ')}`,
  }
}
