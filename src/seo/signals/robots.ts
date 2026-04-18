import robotsParser from 'robots-parser'
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const TRACKED_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot'] as const

// Synthetic origin used only so robots-parser has a consistent URL base to
// reason about. The Plan 2 ScrapeResult doesn't carry the input URL (yet),
// and robots-parser's isAllowed logic only cares about path matching within
// the same origin, so any consistent origin works.
const SYNTHETIC_ROBOTS_URL = 'http://site.invalid/robots.txt'
const SYNTHETIC_ROOT_URL = 'http://site.invalid/'

export function evaluateRobots(scrape: ScrapeResult): SignalResult {
  const content = scrape.structured.robots
  if (content === null) {
    return {
      name: 'robots',
      pass: true,
      weight: SIGNAL_WEIGHT,
      detail: 'robots.txt absent (permissive default)',
    }
  }
  const robots = robotsParser(SYNTHETIC_ROBOTS_URL, content)
  const blocked: string[] = []
  for (const bot of TRACKED_BOTS) {
    const allowed = robots.isAllowed(SYNTHETIC_ROOT_URL, bot)
    if (allowed === false) blocked.push(bot)
  }
  if (blocked.length === 0) {
    return {
      name: 'robots',
      pass: true,
      weight: SIGNAL_WEIGHT,
      detail: 'robots.txt allows GPTBot, ClaudeBot, PerplexityBot',
    }
  }
  return {
    name: 'robots',
    pass: false,
    weight: SIGNAL_WEIGHT,
    detail: `robots.txt blocks: ${blocked.join(', ')}`,
  }
}
