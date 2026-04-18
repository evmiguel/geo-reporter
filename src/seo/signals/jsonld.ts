import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const ALLOWED_TYPES = new Set(['Organization', 'Product', 'WebSite'])

function collectTypes(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const t = obj['@type']
  if (typeof t === 'string') out.add(t)
  else if (Array.isArray(t)) {
    for (const x of t) if (typeof x === 'string') out.add(x)
  }
  const graph = obj['@graph']
  if (Array.isArray(graph)) {
    for (const child of graph) collectTypes(child, out)
  }
}

export function evaluateJsonLd(scrape: ScrapeResult): SignalResult {
  const blocks = scrape.structured.jsonld
  if (blocks.length === 0) {
    return { name: 'jsonld', pass: false, weight: SIGNAL_WEIGHT, detail: 'No JSON-LD found' }
  }
  const typesSeen = new Set<string>()
  for (const block of blocks) {
    if (Array.isArray(block)) {
      for (const child of block) collectTypes(child, typesSeen)
    } else {
      collectTypes(block, typesSeen)
    }
  }
  for (const t of typesSeen) {
    if (ALLOWED_TYPES.has(t)) {
      return { name: 'jsonld', pass: true, weight: SIGNAL_WEIGHT, detail: `JSON-LD @type includes "${t}"` }
    }
  }
  const seen = [...typesSeen].join(', ') || '(none)'
  return {
    name: 'jsonld',
    pass: false,
    weight: SIGNAL_WEIGHT,
    detail: `JSON-LD @type seen: ${seen}; expected Organization, Product, or WebSite`,
  }
}
