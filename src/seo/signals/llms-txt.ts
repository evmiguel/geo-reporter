import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateLlmsTxt(scrape: ScrapeResult): SignalResult {
  const present = scrape.structured.llmsTxt.present
  return {
    name: 'llms-txt',
    pass: present,
    weight: SIGNAL_WEIGHT,
    detail: present ? 'llms.txt reachable' : 'llms.txt not reachable',
  }
}
