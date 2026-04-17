import { chromium, type Browser, type BrowserContext } from 'playwright'
import { FetchError } from './fetch.ts'

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

  async render(url: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
    await this.acquireSlot()
    try {
      const ctx = await this.ensureBrowser()
      const page = await ctx.newPage()
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
      } finally {
        await page.close().catch(() => undefined)
      }
    } finally {
      this.releaseSlot()
    }
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
  return getBrowserPool().render(url, opts)
}
