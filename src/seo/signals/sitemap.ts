import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateSitemap(scrape: ScrapeResult): SignalResult {
  const present = scrape.structured.sitemap.present
  return {
    name: 'sitemap',
    pass: present,
    weight: SIGNAL_WEIGHT,
    detail: present ? 'sitemap.xml reachable' : 'sitemap.xml not reachable',
  }
}
