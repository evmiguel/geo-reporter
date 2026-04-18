export interface CitationInput {
  text: string
  domain: string
}

export function scoreCitation({ text, domain }: CitationInput): number {
  const d = escapeRegex(domain)
  const canonical = new RegExp(`https?://(www\\.)?${d}(/|\\b)`, 'i')
  if (canonical.test(text)) return 100
  const subdomain = new RegExp(`https?://[a-z0-9-]+\\.${d}(/|\\b)`, 'i')
  if (subdomain.test(text)) return 80
  if (new RegExp(`\\b${d}\\b`, 'i').test(text)) return 50
  return 0
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
