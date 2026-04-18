import type { ScrapeResult } from '../scraper/index.ts'
import type { SeoResult, SignalResult } from './types.ts'
import { evaluateTitle } from './signals/title.ts'
import { evaluateDescription } from './signals/description.ts'
import { evaluateCanonical } from './signals/canonical.ts'
import { evaluateTwitterCard } from './signals/twitter-card.ts'
import { evaluateOpenGraph } from './signals/open-graph.ts'
import { evaluateJsonLd } from './signals/jsonld.ts'
import { evaluateRobots } from './signals/robots.ts'
import { evaluateSitemap } from './signals/sitemap.ts'
import { evaluateLlmsTxt } from './signals/llms-txt.ts'
import { evaluateHeadings } from './signals/headings.ts'

export type { SignalResult, SeoResult, SignalName } from './types.ts'
export { SIGNAL_WEIGHT } from './types.ts'

export function evaluateSeo(scrape: ScrapeResult): SeoResult {
  const signals: SignalResult[] = [
    evaluateTitle(scrape),
    evaluateDescription(scrape),
    evaluateCanonical(scrape),
    evaluateTwitterCard(scrape),
    evaluateOpenGraph(scrape),
    evaluateJsonLd(scrape),
    evaluateRobots(scrape),
    evaluateSitemap(scrape),
    evaluateLlmsTxt(scrape),
    evaluateHeadings(scrape),
  ]
  const totalWeight = signals.reduce((s, x) => s + x.weight, 0)
  const passedWeight = signals.filter((s) => s.pass).reduce((s, x) => s + x.weight, 0)
  const score = totalWeight === 0 ? 0 : Math.round((passedWeight / totalWeight) * 100)
  return { score, signals }
}
