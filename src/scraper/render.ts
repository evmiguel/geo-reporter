import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { FetchError } from './fetch.ts'
import { resolveSafeHost, SSRFBlockedError } from './ssrf.ts'

const DEFAULT_RENDER_TIMEOUT_MS = 15_000
const MAX_CONCURRENT_PAGES = 2

export interface RenderResult {
  html: string
  finalUrl: string
}

export interface RenderOptions {
  timeoutMs?: number
}

class BrowserPool {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private active = 0
  private readonly waiters: Array<() => void> = []
  private shuttingDown = false

  private async ensureBrowser(): Promise<BrowserContext> {
    if (this.shuttingDown) throw new Error('BrowserPool is shut down')
    if (this.context) return this.context
    this.browser = await chromium.launch({ args: ['--no-sandbox'] })
    this.context = await this.browser.newContext({
      userAgent: 'GeoReporterBot/1.0 (+https://geo-reporter.example)',
      viewport: { width: 1280, height: 800 },
    })
    // Per-request SSRF guard: Chromium does its own DNS, so we validate every
    // URL pre-dispatch. Redirects re-enter this handler with the post-redirect
    // URL, so a public→private redirect chain (the F-1 bypass) is blocked at
    // the next hop. Subresources that resolve to private IPs are silently
    // aborted — the main page still loads.
    await this.context.route('**/*', async (route) => {
      try {
        const parsed = new URL(route.request().url())
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          await route.abort('blockedbyclient')
          return
        }
        await resolveSafeHost(parsed.hostname)
        await route.continue()
      } catch {
        await route.abort('blockedbyclient')
      }
    })
    return this.context
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < MAX_CONCURRENT_PAGES) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active += 1
  }

  private releaseSlot(): void {
    this.active -= 1
    const next = this.waiters.shift()
    if (next) next()
  }

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    await this.acquireSlot()
    try {
      const ctx = await this.ensureBrowser()
      const page = await ctx.newPage()
      try {
        return await fn(page)
      } finally {
        await page.close().catch(() => undefined)
      }
    } finally {
      this.releaseSlot()
    }
  }

  async render(url: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
    return this.withPage(async (page) => {
      try {
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs })
        if (!response) {
          throw new FetchError('render: no response', 'network')
        }
        if (!response.ok()) {
          throw new FetchError(`render: HTTP ${response.status()}`, 'non-2xx', response.status())
        }
        const html = await page.content()
        return { html, finalUrl: page.url() }
      } catch (err) {
        if (err instanceof FetchError) throw err
        const msg = (err as Error).message
        if (/Timeout/i.test(msg)) throw new FetchError(`render timed out after ${timeoutMs}ms`, 'timeout')
        throw new FetchError(`render failed: ${msg}`, 'network')
      }
    })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.context) {
      await this.context.close().catch(() => undefined)
      this.context = null
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined)
      this.browser = null
    }
  }
}

let singleton: BrowserPool | null = null

export function getBrowserPool(): BrowserPool {
  if (!singleton) singleton = new BrowserPool()
  return singleton
}

export async function shutdownBrowserPool(): Promise<void> {
  if (singleton) {
    await singleton.shutdown()
    singleton = null
  }
}

export async function render(url: string, opts: RenderOptions = {}): Promise<RenderResult> {
  // Fail-fast check before spinning up the browser pool for obviously bad
  // input. The context.route interceptor inside the pool catches the same
  // case post-spawn; this just avoids the cost.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (err) {
    throw new FetchError(`render: invalid url ${url}: ${(err as Error).message}`, 'network')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FetchError(`ssrf: bad protocol ${parsed.protocol}`, 'network')
  }
  try {
    await resolveSafeHost(parsed.hostname)
  } catch (err) {
    if (err instanceof SSRFBlockedError) {
      throw new FetchError(`ssrf: ${err.message}`, 'network')
    }
    throw err
  }
  return getBrowserPool().render(url, opts)
}
