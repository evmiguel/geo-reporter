const RECOMMENDATION_HINTS: RegExp[] = [
  /\bthe best\b/i,
  /\bthe top\b/i,
  /\bbest (choice|option|tool|fit|way)\b/i,
  /\bmost (common|popular|widely[- ]used|reliable|trusted|effective|powerful)\b/i,
  /\bgo[- ]to\b/i,
  /\bleading\b/i,
  /\bpreferred\b/i,
  /\bindustry standard\b/i,
  /\brecommend(ed)?\b/i,
  /\b(largest|biggest|dominant)\b/i,
  /\bworld'?s (largest|biggest|most|leading)\b/i,
  /\b(top|first|primary)\s+(choice|pick|recommendation|option)\b/i,
  /\bcommonly used\b/i,
  /\bwidely (used|adopted)\b/i,
  /\b(de[- ]facto|de facto)\b/i,
  /\b(defaults? to|default choice)\b/i,
]

export interface DiscoverabilityInput {
  text: string
  brand: string
  domain: string
}

export function scoreDiscoverability({ text, brand, domain }: DiscoverabilityInput): number {
  const brandRx = new RegExp(`\\b${escapeRegex(brand)}\\b`, 'i')
  const domainRx = new RegExp(`\\b${escapeRegex(domain)}\\b`, 'i')
  const urlRx = new RegExp(`https?://(www\\.)?${escapeRegex(domain)}`, 'i')

  const mentionsDomain = domainRx.test(text) || urlRx.test(text)

  // Check if brand is mentioned outside of domain mentions
  let mentionsBrand = false
  if (brandRx.test(text)) {
    // Remove domain references and check if brand still matches
    const withoutDomain = text.replace(domainRx, '').replace(urlRx, '')
    mentionsBrand = brandRx.test(withoutDomain)
  }

  if (!mentionsBrand && !mentionsDomain) return 0

  let score = 0
  if (mentionsBrand) score += 50
  if (mentionsDomain) score += 30

  const altListRx = /\b[A-Z][a-zA-Z]{2,},\s*[A-Z][a-zA-Z]{2,},\s*[A-Z][a-zA-Z]{2,}/
  const inAltList = altListRx.test(text)

  const hasRecommendationPhrase = !inAltList && RECOMMENDATION_HINTS.some((rx) => rx.test(text))
  if (hasRecommendationPhrase && mentionsBrand) {
    if (mentionsDomain) score = 100
    else if (score < 80) score = 80
  }

  return Math.max(0, Math.min(100, score))
}

export function brandFromDomain(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter((p) => p && p !== 'www')
  const candidate = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
  const c = candidate ?? ''
  return c.charAt(0).toUpperCase() + c.slice(1)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
