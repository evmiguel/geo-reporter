const HEDGE_PHRASES = [/i'?m not sure/i, /might be/i, /possibly/i, /i think/i, /not certain/i, /could be/i]
const DONT_KNOW_PHRASES = [/i (do not|don'?t) know/i, /i'?m not familiar/i, /never heard/i, /cannot help/i, /unable to/i]

const SPECIFIC_DETAIL_HINTS: RegExp[] = [
  /founded/i,
  /headquartered/i,
  /ceo/i,
  /run by/i,
  /owned by/i,
  /\b(acquired|acquired by|operated by)\b/i,
  /\b(subsidiary|division|parent company)\s+of/i,
  /based in/i,
  /\b(search engine|social network|email service|video platform|marketplace|operating system)\b/i,
  /\b(largest|biggest|most[- ]used)\b/i,
  /\b(million|billion|millions|billions)\s+(of\s+)?(users|customers|people|visits|searches|members)/i,
  /\bprovides?\b/i,
  /\boffers?\b/i,
  /\boperates?\b/i,
  /\bdevelops?\b/i,
  /\bused (in|for|since|by)/i,
]

export interface RecognitionInput {
  text: string
  domain: string
}

export function scoreRecognition({ text, domain }: RecognitionInput): number {
  if (DONT_KNOW_PHRASES.some((rx) => rx.test(text))) return 0
  if (HEDGE_PHRASES.some((rx) => rx.test(text))) return 0

  const lc = text.toLowerCase()
  const brand = brandFromDomainLocal(domain).toLowerCase()
  const mentioned = lc.includes(domain.toLowerCase()) || lc.includes(brand)
  if (!mentioned) return 0

  const matches = SPECIFIC_DETAIL_HINTS.filter((rx) => rx.test(text)).length

  let score = 50
  if (matches >= 3) score += 50
  else if (matches === 2) score += 35
  else if (matches === 1) score += 20

  return Math.max(0, Math.min(100, score))
}

function brandFromDomainLocal(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter((p) => p && p !== 'www')
  const candidate = parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!
  return (candidate ?? '').charAt(0).toUpperCase() + (candidate ?? '').slice(1)
}
