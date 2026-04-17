import { fetchHtml } from './fetch.ts'
import { render } from './render.ts'
import { extractVisibleText } from './text.ts'
import {
  extractJsonLd,
  extractOpenGraph,
  extractMeta,
  extractHeadings,
} from './extractors.ts'
import {
  fetchRobotsTxt,
  fetchSitemapStatus,
  fetchLlmsTxtStatus,
} from './discovery.ts'
import type { ScrapeOptions, ScrapeResult, StructuredData } from './types.ts'

export type { ScrapeResult, ScrapeOptions, StructuredData } from './types.ts'
export { FetchError } from './fetch.ts'
export { shutdownBrowserPool } from './render.ts'

const DEFAULT_MIN_STATIC_TEXT = 1000

export async function scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  const minText = opts.minTextLengthForStatic ?? DEFAULT_MIN_STATIC_TEXT

  let staticHtml: string | null = null
  let staticFinalUrl = url
  try {
    const staticRes = await fetchHtml(url, opts.fetchTimeoutMs !== undefined ? { timeoutMs: opts.fetchTimeoutMs } : {})
    staticHtml = staticRes.html
    staticFinalUrl = staticRes.finalUrl
  } catch {
    // fall through — try Playwright
  }

  let finalHtml = staticHtml
  let finalUrl = staticFinalUrl
  let rendered = false
  const staticText = staticHtml ? extractVisibleText(staticHtml) : ''

  const shouldRender = staticHtml === null || staticText.length < minText
  if (shouldRender) {
    try {
      const r = await render(url, opts.renderTimeoutMs !== undefined ? { timeoutMs: opts.renderTimeoutMs } : {})
      finalHtml = r.html
      finalUrl = r.finalUrl
      rendered = true
    } catch {
      // If static also failed, propagate below. Otherwise keep the thin static result.
    }
  }

  if (finalHtml === null) {
    throw new Error(`scrape failed: unable to fetch or render ${url}`)
  }

  const text = rendered ? extractVisibleText(finalHtml) : staticText

  const [robots, sitemap, llmsTxt] = await Promise.all([
    fetchRobotsTxt(finalUrl),
    fetchSitemapStatus(finalUrl),
    fetchLlmsTxtStatus(finalUrl),
  ])

  const structured: StructuredData = {
    jsonld: extractJsonLd(finalHtml),
    og: extractOpenGraph(finalHtml),
    meta: extractMeta(finalHtml),
    headings: extractHeadings(finalHtml),
    robots,
    sitemap,
    llmsTxt,
  }

  return {
    rendered,
    html: finalHtml,
    text,
    structured,
  }
}
