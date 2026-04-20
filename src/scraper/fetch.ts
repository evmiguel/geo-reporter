import { resolveSafeHost, SSRFBlockedError } from './ssrf.ts'

export type FetchFailureReason =
  | 'non-2xx'
  | 'non-html-content-type'
  | 'timeout'
  | 'network'

export class FetchError extends Error {
  override readonly name = 'FetchError'
  constructor(
    message: string,
    readonly reason: FetchFailureReason,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface FetchHtmlResult {
  html: string
  finalUrl: string
  contentType: string
}

export interface FetchHtmlOptions {
  timeoutMs?: number
  userAgent?: string
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_UA = 'GeoReporterBot/1.0 (+https://geo-reporter.example)'

export async function fetchHtml(
  url: string,
  opts: FetchHtmlOptions = {},
): Promise<FetchHtmlResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ua = opts.userAgent ?? DEFAULT_UA
  if (process.env.NODE_ENV === 'production') {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch (err) {
      throw new FetchError(`invalid url: ${(err as Error).message}`, 'network')
    }
    try {
      await resolveSafeHost(parsedUrl.hostname)
    } catch (err) {
      if (err instanceof SSRFBlockedError) {
        throw new FetchError(`ssrf: ${err.message}`, 'network')
      }
      throw err
    }
  }
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': ua, accept: 'text/html,*/*;q=0.8' },
    })
  } catch (err) {
    clearTimeout(t)
    if ((err as Error).name === 'AbortError') {
      throw new FetchError(`fetch timed out after ${timeoutMs}ms`, 'timeout')
    }
    throw new FetchError(`network error: ${(err as Error).message}`, 'network')
  }
  clearTimeout(t)
  if (!res.ok) {
    throw new FetchError(`HTTP ${res.status}`, 'non-2xx', res.status)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!/\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(contentType)) {
    throw new FetchError(`non-html content-type: ${contentType}`, 'non-html-content-type')
  }
  const html = await res.text()
  return { html, finalUrl: res.url || url, contentType }
}
