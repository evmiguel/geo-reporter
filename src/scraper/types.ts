export interface OpenGraph {
  title?: string
  description?: string
  image?: string
  type?: string
  url?: string
}

export interface MetaData {
  title?: string
  description?: string
  canonical?: string
  twitterCard?: string
  viewport?: string
}

export interface Headings {
  h1: string[]
  h2: string[]
}

export interface SitemapStatus {
  present: boolean
  url: string
}

export interface LlmsTxtStatus {
  present: boolean
  url: string
}

export interface StructuredData {
  jsonld: unknown[]
  og: OpenGraph
  meta: MetaData
  headings: Headings
  robots: string | null
  sitemap: SitemapStatus
  llmsTxt: LlmsTxtStatus
}

export interface ScrapeResult {
  rendered: boolean
  html: string
  text: string
  structured: StructuredData
}

export interface ScrapeOptions {
  fetchTimeoutMs?: number
  renderTimeoutMs?: number
  minTextLengthForStatic?: number
}
