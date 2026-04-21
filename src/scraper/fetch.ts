import { safeFetch, type SafeFetchDeps } from './safe-fetch.ts'
import { SSRFBlockedError } from './ssrf.ts'

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
  deps: SafeFetchDeps = {},
): Promise<FetchHtmlResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ua = opts.userAgent ?? DEFAULT_UA
  let res: Response
  try {
    res = await safeFetch(
      url,
      { timeoutMs, headers: { 'user-agent': ua, accept: 'text/html,*/*;q=0.8' } },
      deps,
    )
  } catch (err) {
    if (err instanceof SSRFBlockedError) {
      throw new FetchError(`ssrf: ${err.message}`, 'network')
    }
    const name = (err as Error).name
    if (name === 'AbortError') {
      throw new FetchError(`fetch timed out after ${timeoutMs}ms`, 'timeout')
    }
    if ((err as Error).message === 'too many redirects') {
      throw new FetchError('too many redirects', 'network')
    }
    throw new FetchError(`network error: ${(err as Error).message}`, 'network')
  }
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
