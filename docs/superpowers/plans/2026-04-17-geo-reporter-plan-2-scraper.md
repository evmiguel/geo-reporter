# GEO Reporter Plan 2 — Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a library-only `src/scraper/` module that takes a URL and returns structured page data (HTML, visible text, JSON-LD, Open Graph, meta, headings, robots.txt, sitemap presence, llms.txt presence) with a static-fetch-first / Playwright-fallback pipeline. No HTTP routes, no DB writes — caller (Plan 5) decides persistence.

**Architecture:** Static `fetch()` first; if extracted visible text < 1000 chars, fall back to a shared Playwright Chromium pool (max 2 concurrent pages, 15s page timeout). All HTML parsing goes through `cheerio`. The discovery probes (`robots.txt`, `sitemap.xml`, `llms.txt`) are independent HTTP GETs against the URL origin — they don't require a rendered page.

**Tech Stack:** `playwright` (Chromium only), `cheerio` for DOM queries, Node's built-in `http` + `AbortController` for plain fetch and fixture servers, vitest for unit and integration tests. Existing v3 constraints apply: `.ts` import extensions, `import type` for types, strict TS, `exactOptionalPropertyTypes`.

**Out of scope (explicit):**
- Persistence. Plan 5 wires the scraper output into `GradeStore.createScrape`.
- Retry/backoff. BullMQ handles that at the job layer.
- Per-domain rate limiting. Not relevant for homepage-only scraping of a user-submitted URL.
- Robots.txt user-agent enforcement — we fetch robots for *reporting* (SEO signal), not to gate our own access. A public homepage that blocks us is itself a data point.

---

## File Structure

```
src/scraper/
├── types.ts         — ScrapeResult, StructuredData, OpenGraph, MetaData, Headings, SitemapStatus, LlmsTxtStatus
├── fetch.ts         — plain-HTTP GET with timeout, returns { html, finalUrl, contentType }
├── text.ts          — cheerio-based visible-text extractor (strips script/style/noscript, normalizes whitespace)
├── extractors.ts    — extractJsonLd, extractOpenGraph, extractMeta, extractHeadings
├── discovery.ts     — fetchRobotsTxt, fetchSitemapStatus, fetchLlmsTxtStatus (separate GETs)
├── render.ts        — BrowserPool (lazy-init Chromium, max 2 pages, 15s timeout), render(url)
└── index.ts         — scrape(url) orchestrator: fetch → text → (maybe render) → extract → compose

tests/unit/scraper/
├── fixtures/
│   ├── rich.html         — full meta + OG + JSON-LD + h1/h2 + >1000 chars of visible text
│   ├── sparse.html       — <500 chars visible text (triggers fallback in integration test)
│   ├── jsonld-multi.html — two valid JSON-LD blocks + one malformed
│   ├── og-missing.html   — no OG tags, has basic meta
│   └── empty.html        — <html><body></body></html>
├── text.test.ts
├── extractors.test.ts
├── fetch.test.ts         — mocks global fetch
├── discovery.test.ts     — mocks global fetch
└── index.test.ts         — mocks fetch + render; asserts fallback branch logic

tests/integration/
└── scraper.test.ts       — spins up Node http.Server serving fixtures + SPA page; asserts real Playwright fallback works
```

**Rationale for the split:** `fetch.ts`, `text.ts`, `extractors.ts`, and `discovery.ts` are pure-ish and independently unit-testable. `render.ts` owns all Playwright state (singleton pool, graceful shutdown). `index.ts` is thin composition — holds the < 1000 char fallback rule and nothing else. Keeps blast radius of a Playwright crash or API change to one file.

---

## Dependencies to add

| Package | Role | Kind |
|---|---|---|
| `playwright` | Chromium automation for fallback render | runtime |
| `cheerio` | jQuery-ish HTML parsing for extractors | runtime |

Both are runtime because the worker imports them at grade time. Cheerio ships its own types; no `@types/cheerio` needed on modern versions.

**Chromium binary install** (`playwright install chromium`) is a separate step — `pnpm install` doesn't fetch browsers. It must run in CI and on any fresh local checkout. Added to CI in Task 1.

---

## Task 1 — Dependencies, fixtures, CI (fresh)

**Files:**
- Modify: `package.json` (add deps)
- Create: `tests/unit/scraper/fixtures/rich.html`
- Create: `tests/unit/scraper/fixtures/sparse.html`
- Create: `tests/unit/scraper/fixtures/jsonld-multi.html`
- Create: `tests/unit/scraper/fixtures/og-missing.html`
- Create: `tests/unit/scraper/fixtures/empty.html`
- Create: `.github/workflows/ci.yml` (NEW — Plan 1's CI task targeted the old monorepo path, silently dropped when v3 was extracted to a standalone repo; creating fresh here).

- [ ] **Step 1: Add runtime dependencies**

Run:
```bash
pnpm add playwright@^1.47.0 cheerio@^1.0.0
```

Expected: both appear under `dependencies` in `package.json`.

- [ ] **Step 2: Install Chromium locally**

Run:
```bash
pnpm exec playwright install chromium
```

Expected: Chromium downloads to `~/.cache/ms-playwright/chromium-*`. Takes 30–90s on first run; subsequent invocations are no-ops.

- [ ] **Step 3: Create the fixture HTML files**

Write `tests/unit/scraper/fixtures/rich.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <title>Acme Widgets — Industrial-Grade Sprockets</title>
  <meta name="description" content="Acme Widgets has been manufacturing precision sprockets for industrial applications since 1923, serving aerospace, automotive, and marine clients across 40 countries.">
  <link rel="canonical" href="https://acme.example/">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="twitter:card" content="summary_large_image">
  <meta property="og:title" content="Acme Widgets">
  <meta property="og:description" content="Precision sprockets since 1923.">
  <meta property="og:image" content="https://acme.example/og.png">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://acme.example/">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Organization","name":"Acme Widgets","url":"https://acme.example"}
  </script>
</head>
<body>
  <h1>Industrial-Grade Sprockets</h1>
  <h2>Why Acme</h2>
  <p>Acme Widgets has been manufacturing precision sprockets for industrial applications since 1923. Our foundry in Pittsburgh produces over two million units annually, serving aerospace, automotive, and marine clients across forty countries. Every sprocket is forged from high-carbon alloy steel and passes a 47-point inspection before it leaves the floor.</p>
  <h2>Clients</h2>
  <p>We supply Boeing, General Motors, Caterpillar, and the United States Navy, among others. Our sprockets power everything from commercial aircraft landing gear to submarine propulsion assemblies. The longest continuous contract we hold is with a Midwest agricultural equipment manufacturer and has run, without interruption, since 1958.</p>
  <h2>Facilities</h2>
  <p>Our Pittsburgh plant spans 340,000 square feet and employs 420 machinists, metallurgists, and quality engineers. A secondary finishing facility in Hamilton, Ontario handles nickel and chromium plating for the marine and food-service lines. We maintain ISO 9001 and AS9100 certifications and submit to quarterly audits from three major defense contractors.</p>
  <script>/* tracking code */</script>
  <style>/* inline css */</style>
</body>
</html>
```

Write `tests/unit/scraper/fixtures/sparse.html`:
```html
<!doctype html>
<html><head><title>SPA App</title></head>
<body><div id="root"></div><script>/* client renders */</script></body></html>
```

Write `tests/unit/scraper/fixtures/jsonld-multi.html`:
```html
<!doctype html>
<html><head>
<script type="application/ld+json">{"@type":"Organization","name":"Alpha"}</script>
<script type="application/ld+json">{"@type":"WebSite","name":"Alpha Site"}</script>
<script type="application/ld+json">{ not valid json </script>
</head><body></body></html>
```

Write `tests/unit/scraper/fixtures/og-missing.html`:
```html
<!doctype html>
<html><head>
<title>Basic Page</title>
<meta name="description" content="A plain page with no Open Graph tags.">
</head><body><h1>Hello</h1></body></html>
```

Write `tests/unit/scraper/fixtures/empty.html`:
```html
<!doctype html>
<html><body></body></html>
```

- [ ] **Step 4: Create CI workflow**

Plan 1 Task 14 wrote a workflow for the old monorepo shape (`v3/` subdir, `working-directory: v3`, path-filtered on `v3/**`). That shape no longer matches the standalone repo and the workflow was never ported. Creating fresh here, scoped correctly for the standalone repo.

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9.6.0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Install Playwright Chromium
        run: pnpm exec playwright install --with-deps chromium

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test

      - name: Integration tests
        run: pnpm test:integration

      - name: Build
        run: pnpm build
```

Notes on this workflow:
- `ubuntu-latest` ships Docker, which testcontainers needs for the integration suite.
- `--with-deps chromium` installs both the browser binary and the Linux system libraries it needs (fonts, nss, etc.), which is what Playwright documents for headless Chromium on GitHub-hosted Ubuntu runners.
- Build runs last so a type/test failure short-circuits before we waste time bundling.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -am "chore(v3): add playwright + cheerio deps, scraper fixtures, CI chromium install"
```

---

## Task 2 — Public types

**Files:**
- Create: `src/scraper/types.ts`

- [ ] **Step 1: Write the types file**

Create `src/scraper/types.ts`:
```ts
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
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/scraper/types.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(scraper): define public types"
```

---

## Task 3 — Visible-text extractor (TDD)

**Files:**
- Test: `tests/unit/scraper/text.test.ts`
- Create: `src/scraper/text.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scraper/text.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { extractVisibleText } from '../../../src/scraper/text.ts'

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')

describe('extractVisibleText', () => {
  it('strips script, style, and noscript tags', () => {
    const html = '<html><body><p>keep</p><script>drop()</script><style>.x{}</style><noscript>drop</noscript></body></html>'
    expect(extractVisibleText(html)).toBe('keep')
  })

  it('normalizes runs of whitespace to single spaces', () => {
    const html = '<p>a  \n\n  b\t\tc</p>'
    expect(extractVisibleText(html)).toBe('a b c')
  })

  it('returns empty string for empty body', () => {
    expect(extractVisibleText(fixture('empty.html'))).toBe('')
  })

  it('extracts >1000 chars from rich fixture', () => {
    expect(extractVisibleText(fixture('rich.html')).length).toBeGreaterThan(1000)
  })

  it('sparse SPA fixture yields very little text', () => {
    expect(extractVisibleText(fixture('sparse.html')).length).toBeLessThan(50)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/scraper/text.test.ts
```

Expected: FAIL — module `src/scraper/text.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/scraper/text.ts`:
```ts
import * as cheerio from 'cheerio'

export function extractVisibleText(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, noscript, template').remove()
  const raw = $('body').text() || $.root().text()
  return raw.replace(/\s+/g, ' ').trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/scraper/text.test.ts
```

Expected: PASS — 5/5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/scraper/text.ts tests/unit/scraper/text.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(scraper): extractVisibleText with cheerio"
```

---

## Task 4 — JSON-LD, OG, meta, headings extractors (TDD)

**Files:**
- Test: `tests/unit/scraper/extractors.test.ts`
- Create: `src/scraper/extractors.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scraper/extractors.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  extractJsonLd,
  extractOpenGraph,
  extractMeta,
  extractHeadings,
} from '../../../src/scraper/extractors.ts'

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')

describe('extractJsonLd', () => {
  it('parses a single JSON-LD block', () => {
    const blocks = extractJsonLd(fixture('rich.html'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ '@type': 'Organization', name: 'Acme Widgets' })
  })

  it('returns all valid blocks and silently drops malformed JSON', () => {
    const blocks = extractJsonLd(fixture('jsonld-multi.html'))
    expect(blocks).toHaveLength(2)
    expect((blocks[0] as Record<string, unknown>)['@type']).toBe('Organization')
    expect((blocks[1] as Record<string, unknown>)['@type']).toBe('WebSite')
  })

  it('returns empty array when no JSON-LD scripts exist', () => {
    expect(extractJsonLd(fixture('og-missing.html'))).toEqual([])
  })
})

describe('extractOpenGraph', () => {
  it('reads all og:* properties from the rich fixture', () => {
    expect(extractOpenGraph(fixture('rich.html'))).toEqual({
      title: 'Acme Widgets',
      description: 'Precision sprockets since 1923.',
      image: 'https://acme.example/og.png',
      type: 'website',
      url: 'https://acme.example/',
    })
  })

  it('returns an empty object (no keys) when no og tags are present', () => {
    expect(extractOpenGraph(fixture('og-missing.html'))).toEqual({})
  })
})

describe('extractMeta', () => {
  it('reads title, description, canonical, twitter card, viewport', () => {
    expect(extractMeta(fixture('rich.html'))).toEqual({
      title: 'Acme Widgets — Industrial-Grade Sprockets',
      description: expect.stringContaining('since 1923'),
      canonical: 'https://acme.example/',
      twitterCard: 'summary_large_image',
      viewport: 'width=device-width, initial-scale=1',
    })
  })

  it('returns only the fields that are present', () => {
    const meta = extractMeta(fixture('og-missing.html'))
    expect(meta.title).toBe('Basic Page')
    expect(meta.description).toBe('A plain page with no Open Graph tags.')
    expect(meta.canonical).toBeUndefined()
    expect(meta.twitterCard).toBeUndefined()
  })
})

describe('extractHeadings', () => {
  it('collects every h1 and h2 in document order, trimmed', () => {
    expect(extractHeadings(fixture('rich.html'))).toEqual({
      h1: ['Industrial-Grade Sprockets'],
      h2: ['Why Acme', 'Clients', 'Facilities'],
    })
  })

  it('returns empty arrays when no headings exist', () => {
    expect(extractHeadings(fixture('empty.html'))).toEqual({ h1: [], h2: [] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/scraper/extractors.test.ts
```

Expected: FAIL — module `src/scraper/extractors.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/scraper/extractors.ts`:
```ts
import * as cheerio from 'cheerio'
import type { OpenGraph, MetaData, Headings } from './types.ts'

export function extractJsonLd(html: string): unknown[] {
  const $ = cheerio.load(html)
  const out: unknown[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim()
    if (!raw) return
    try {
      out.push(JSON.parse(raw))
    } catch {
      // Drop malformed blocks silently — real sites ship broken JSON-LD regularly.
    }
  })
  return out
}

export function extractOpenGraph(html: string): OpenGraph {
  const $ = cheerio.load(html)
  const pick = (prop: string): string | undefined => {
    const v = $(`meta[property="og:${prop}"]`).attr('content')?.trim()
    return v && v.length > 0 ? v : undefined
  }
  const out: OpenGraph = {}
  const title = pick('title')
  const description = pick('description')
  const image = pick('image')
  const type = pick('type')
  const url = pick('url')
  if (title !== undefined) out.title = title
  if (description !== undefined) out.description = description
  if (image !== undefined) out.image = image
  if (type !== undefined) out.type = type
  if (url !== undefined) out.url = url
  return out
}

export function extractMeta(html: string): MetaData {
  const $ = cheerio.load(html)
  const attr = (sel: string): string | undefined => {
    const v = $(sel).attr('content')?.trim()
    return v && v.length > 0 ? v : undefined
  }
  const out: MetaData = {}
  const title = $('head > title').first().text().trim()
  if (title.length > 0) out.title = title
  const description = attr('meta[name="description"]')
  if (description !== undefined) out.description = description
  const canonical = $('link[rel="canonical"]').attr('href')?.trim()
  if (canonical && canonical.length > 0) out.canonical = canonical
  const twitterCard = attr('meta[name="twitter:card"]')
  if (twitterCard !== undefined) out.twitterCard = twitterCard
  const viewport = attr('meta[name="viewport"]')
  if (viewport !== undefined) out.viewport = viewport
  return out
}

export function extractHeadings(html: string): Headings {
  const $ = cheerio.load(html)
  const collect = (sel: string): string[] => {
    const arr: string[] = []
    $(sel).each((_, el) => {
      const t = $(el).text().trim()
      if (t.length > 0) arr.push(t)
    })
    return arr
  }
  return { h1: collect('h1'), h2: collect('h2') }
}
```

Explicit-assignment note: because `exactOptionalPropertyTypes: true` is on, we cannot pass `{ title: undefined }` as a partial — we must omit keys entirely. Hence the per-key `if (x !== undefined)` pattern.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/scraper/extractors.test.ts
```

Expected: PASS — all describe-blocks green.

- [ ] **Step 5: Commit**

```bash
git add src/scraper/extractors.ts tests/unit/scraper/extractors.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(scraper): JSON-LD, OG, meta, headings extractors"
```

---

## Task 5 — Plain HTTP fetch wrapper (TDD with mocked global fetch)

**Files:**
- Test: `tests/unit/scraper/fetch.test.ts`
- Create: `src/scraper/fetch.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scraper/fetch.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchHtml, FetchError } from '../../../src/scraper/fetch.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockFetch(impl: typeof fetch): void {
  globalThis.fetch = impl as unknown as typeof fetch
}

describe('fetchHtml', () => {
  it('returns html + finalUrl + contentType on 200', async () => {
    mockFetch(async () => new Response('<html>ok</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))
    const got = await fetchHtml('https://example.com/')
    expect(got.html).toBe('<html>ok</html>')
    expect(got.contentType).toBe('text/html; charset=utf-8')
    expect(got.finalUrl).toBe('https://example.com/')
  })

  it('throws FetchError on non-2xx', async () => {
    mockFetch(async () => new Response('nope', { status: 503 }))
    await expect(fetchHtml('https://example.com/')).rejects.toBeInstanceOf(FetchError)
  })

  it('throws FetchError when content-type is not html-ish', async () => {
    mockFetch(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(fetchHtml('https://example.com/')).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'non-html-content-type',
    })
  })

  it('aborts after the configured timeout', async () => {
    mockFetch((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))
    await expect(fetchHtml('https://example.com/', { timeoutMs: 20 })).rejects.toMatchObject({
      name: 'FetchError',
      reason: 'timeout',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/scraper/fetch.test.ts
```

Expected: FAIL — module `src/scraper/fetch.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/scraper/fetch.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/scraper/fetch.test.ts
```

Expected: PASS — 4/4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/scraper/fetch.ts tests/unit/scraper/fetch.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(scraper): fetchHtml with timeout, content-type guard, FetchError"
```

---

## Task 6 — Discovery probes: robots.txt, sitemap.xml, llms.txt (TDD)

**Files:**
- Test: `tests/unit/scraper/discovery.test.ts`
- Create: `src/scraper/discovery.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scraper/discovery.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchRobotsTxt,
  fetchSitemapStatus,
  fetchLlmsTxtStatus,
} from '../../../src/scraper/discovery.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return handler(url)
  }) as unknown as typeof fetch
}

describe('fetchRobotsTxt', () => {
  it('returns body on 200', async () => {
    stubFetch(() => new Response('User-agent: *\nAllow: /', { status: 200 }))
    expect(await fetchRobotsTxt('https://example.com')).toBe('User-agent: *\nAllow: /')
  })

  it('returns null on 404', async () => {
    stubFetch(() => new Response('', { status: 404 }))
    expect(await fetchRobotsTxt('https://example.com')).toBeNull()
  })

  it('returns null on network error', async () => {
    stubFetch(() => { throw new Error('refused') })
    expect(await fetchRobotsTxt('https://example.com')).toBeNull()
  })

  it('hits the origin with /robots.txt path', async () => {
    let seen = ''
    stubFetch((u) => { seen = u; return new Response('ok', { status: 200 }) })
    await fetchRobotsTxt('https://sub.example.com/deep/path?x=1')
    expect(seen).toBe('https://sub.example.com/robots.txt')
  })
})

describe('fetchSitemapStatus', () => {
  it('present=true on 200', async () => {
    stubFetch(() => new Response('<urlset/>', { status: 200 }))
    expect(await fetchSitemapStatus('https://example.com')).toEqual({
      present: true,
      url: 'https://example.com/sitemap.xml',
    })
  })

  it('present=false on 404', async () => {
    stubFetch(() => new Response('', { status: 404 }))
    expect(await fetchSitemapStatus('https://example.com')).toEqual({
      present: false,
      url: 'https://example.com/sitemap.xml',
    })
  })
})

describe('fetchLlmsTxtStatus', () => {
  it('present=true on 200', async () => {
    stubFetch(() => new Response('# About\n...', { status: 200 }))
    expect(await fetchLlmsTxtStatus('https://example.com')).toEqual({
      present: true,
      url: 'https://example.com/llms.txt',
    })
  })

  it('present=false on 404', async () => {
    stubFetch(() => new Response('', { status: 404 }))
    expect(await fetchLlmsTxtStatus('https://example.com')).toEqual({
      present: false,
      url: 'https://example.com/llms.txt',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/scraper/discovery.test.ts
```

Expected: FAIL — module `src/scraper/discovery.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/scraper/discovery.ts`:
```ts
import type { SitemapStatus, LlmsTxtStatus } from './types.ts'

const TIMEOUT_MS = 5_000

function originOf(inputUrl: string): string {
  const u = new URL(inputUrl)
  return `${u.protocol}//${u.host}`
}

async function headOrGetStatus(url: string): Promise<{ ok: boolean; body: string | null }> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    clearTimeout(t)
    if (!res.ok) return { ok: false, body: null }
    const body = await res.text()
    return { ok: true, body }
  } catch {
    clearTimeout(t)
    return { ok: false, body: null }
  }
}

export async function fetchRobotsTxt(inputUrl: string): Promise<string | null> {
  const url = `${originOf(inputUrl)}/robots.txt`
  const r = await headOrGetStatus(url)
  return r.ok ? r.body : null
}

export async function fetchSitemapStatus(inputUrl: string): Promise<SitemapStatus> {
  const url = `${originOf(inputUrl)}/sitemap.xml`
  const r = await headOrGetStatus(url)
  return { present: r.ok, url }
}

export async function fetchLlmsTxtStatus(inputUrl: string): Promise<LlmsTxtStatus> {
  const url = `${originOf(inputUrl)}/llms.txt`
  const r = await headOrGetStatus(url)
  return { present: r.ok, url }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/scraper/discovery.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/scraper/discovery.ts tests/unit/scraper/discovery.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(scraper): robots.txt + sitemap.xml + llms.txt discovery probes"
```

---

## Task 7 — Playwright browser pool

**Files:**
- Create: `src/scraper/render.ts`

Unit-testing real Playwright is out of proportion to the value; pool behavior is covered by the Task 10 integration test. This task ships the implementation alongside a typecheck gate.

- [ ] **Step 1: Write the implementation**

Create `src/scraper/render.ts`:
```ts
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
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Register pool shutdown in worker entrypoint**

Per the CLAUDE.md footgun about adding new long-lived resources: modify `src/worker/worker.ts` so Chromium closes on SIGTERM/SIGINT alongside Redis and the DB.

The current `src/worker/worker.ts` looks like:
```ts
import { env } from '../config/env.ts'
import { closeDb } from '../db/client.ts'
import { createRedis } from '../queue/redis.ts'
import { registerHealthWorker } from '../queue/workers/health.ts'

const connection = createRedis(env.REDIS_URL)
const workers = [registerHealthWorker(connection)]

console.log(JSON.stringify({ msg: 'worker started', workers: workers.length }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'worker shutting down', signal }))
  await Promise.all(workers.map((w) => w.close()))
  await connection.quit()
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

Apply two edits:

1. Add an import line. After `import { registerHealthWorker } from '../queue/workers/health.ts'` add:
```ts
import { shutdownBrowserPool } from '../scraper/render.ts'
```

2. Inside `shutdown()`, after `await closeDb()` and before `process.exit(0)`, add:
```ts
await shutdownBrowserPool()
```

Reasoning for the ordering: the DB + Redis close fast, Chromium shutdown can take several seconds, and we want the fast resources released first in case Railway's SIGKILL grace window is tight. Also: the pool is lazy, so if it was never used, `shutdownBrowserPool()` is a no-op — no cost.

- [ ] **Step 4: Typecheck again after worker edit**

Run:
```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/scraper/render.ts src/worker/worker.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(scraper): Playwright pool (max 2 pages, 15s timeout) + worker shutdown hook"
```

---

## Task 8 — Scraper entrypoint with fallback logic (TDD)

**Files:**
- Test: `tests/unit/scraper/index.test.ts`
- Create: `src/scraper/index.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scraper/index.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// All mocks must be set up BEFORE importing the module under test.
vi.mock('../../../src/scraper/fetch.ts', () => ({
  fetchHtml: vi.fn(),
  FetchError: class FetchError extends Error {
    constructor(msg: string, public reason: string) { super(msg) }
  },
}))
vi.mock('../../../src/scraper/render.ts', () => ({
  render: vi.fn(),
}))
vi.mock('../../../src/scraper/discovery.ts', () => ({
  fetchRobotsTxt: vi.fn(async () => null),
  fetchSitemapStatus: vi.fn(async () => ({ present: false, url: 'https://e/sitemap.xml' })),
  fetchLlmsTxtStatus: vi.fn(async () => ({ present: false, url: 'https://e/llms.txt' })),
}))

const { fetchHtml } = await import('../../../src/scraper/fetch.ts')
const { render } = await import('../../../src/scraper/render.ts')
const { scrape } = await import('../../../src/scraper/index.ts')

const richHtml = `
  <html><head><title>A</title></head>
  <body>${'word '.repeat(400)}</body></html>`

const sparseHtml = `<html><head><title>SPA</title></head><body><div id="root"></div></body></html>`

beforeEach(() => {
  vi.mocked(fetchHtml).mockReset()
  vi.mocked(render).mockReset()
})

afterEach(() => vi.restoreAllMocks())

describe('scrape', () => {
  it('skips render when static HTML already has >=1000 chars of visible text', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({ html: richHtml, finalUrl: 'https://e/', contentType: 'text/html' })
    const r = await scrape('https://e/')
    expect(r.rendered).toBe(false)
    expect(r.text.length).toBeGreaterThanOrEqual(1000)
    expect(render).not.toHaveBeenCalled()
  })

  it('falls back to Playwright when static text is too thin', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({ html: sparseHtml, finalUrl: 'https://e/', contentType: 'text/html' })
    vi.mocked(render).mockResolvedValue({ html: richHtml, finalUrl: 'https://e/' })
    const r = await scrape('https://e/')
    expect(r.rendered).toBe(true)
    expect(r.text.length).toBeGreaterThanOrEqual(1000)
    expect(render).toHaveBeenCalledOnce()
  })

  it('falls back to Playwright when static fetch fails outright', async () => {
    vi.mocked(fetchHtml).mockRejectedValue(new Error('boom'))
    vi.mocked(render).mockResolvedValue({ html: richHtml, finalUrl: 'https://e/' })
    const r = await scrape('https://e/')
    expect(r.rendered).toBe(true)
    expect(render).toHaveBeenCalledOnce()
  })

  it('keeps static result if render also fails', async () => {
    vi.mocked(fetchHtml).mockResolvedValue({ html: sparseHtml, finalUrl: 'https://e/', contentType: 'text/html' })
    vi.mocked(render).mockRejectedValue(new Error('render-boom'))
    const r = await scrape('https://e/')
    expect(r.rendered).toBe(false)
    expect(r.html).toBe(sparseHtml)
  })

  it('throws when BOTH static fetch and render fail', async () => {
    vi.mocked(fetchHtml).mockRejectedValue(new Error('boom1'))
    vi.mocked(render).mockRejectedValue(new Error('boom2'))
    await expect(scrape('https://e/')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/scraper/index.test.ts
```

Expected: FAIL — module `src/scraper/index.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/scraper/index.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/scraper/index.test.ts
```

Expected: PASS — all 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/scraper/index.ts tests/unit/scraper/index.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(scraper): entrypoint with static-first / Playwright-fallback logic"
```

---

## Task 9 — Export scraper from package surface

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Read current package surface**

Read `src/index.ts` end-to-end. Note the existing exports.

- [ ] **Step 2: Add scraper re-exports**

Add these exports to `src/index.ts` alongside the existing ones (do not remove or rename existing exports):
```ts
export { scrape, shutdownBrowserPool, FetchError } from './scraper/index.ts'
export type { ScrapeResult, ScrapeOptions, StructuredData } from './scraper/index.ts'
```

- [ ] **Step 3: Typecheck + full unit test run**

Run:
```bash
pnpm typecheck && pnpm test
```

Expected: typecheck clean; every unit test (including Plan 1's) passes.

- [ ] **Step 4: Build**

Run:
```bash
pnpm build
```

Expected: tsup completes without errors. `dist/server.js` and `dist/worker.js` exist.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(scraper): re-export public surface from src/index.ts"
```

---

## Task 10 — Integration test: real Playwright against a local fixture server

**Files:**
- Create: `tests/integration/scraper.test.ts`

This is the one place we actually launch Chromium. Two scenarios:
1. Rich static page → `rendered: false`, structured data extracted.
2. Sparse SPA page (empty `<body><div id="root"></div></body>` plus a `<script>` that fills it) → `rendered: true` after Playwright runs.

- [ ] **Step 1: Write the integration test**

Create `tests/integration/scraper.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { scrape, shutdownBrowserPool } from '../../src/scraper/index.ts'

const RICH = `<!doctype html>
<html><head>
<title>Rich Static Page</title>
<meta name="description" content="A richly populated static page, fully rendered server-side, for integration testing the scraper fallback heuristics.">
<link rel="canonical" href="http://static.example/">
<meta property="og:title" content="Rich Static">
<meta property="og:image" content="https://img.example/og.png">
<script type="application/ld+json">{"@type":"Organization","name":"Static Co"}</script>
</head><body>
<h1>Hello</h1>
<h2>Details</h2>
<p>${'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(40)}</p>
</body></html>`

const SPA = `<!doctype html>
<html><head><title>SPA</title></head>
<body><div id="root"></div>
<script>
  document.addEventListener('DOMContentLoaded', function () {
    var root = document.getElementById('root');
    var p = document.createElement('p');
    p.textContent = '${'client-rendered content '.repeat(80)}';
    root.appendChild(p);
  });
</script>
</body></html>`

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/rich') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(RICH)
      return
    }
    if (req.url === '/spa') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SPA)
      return
    }
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('User-agent: *\nAllow: /')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
}, 30_000)

afterAll(async () => {
  await shutdownBrowserPool()
  await new Promise<void>((r) => server.close(() => r()))
}, 30_000)

describe('scrape — integration', () => {
  it('rich static page: rendered=false, structured data extracted', async () => {
    const r = await scrape(`${base}/rich`)
    expect(r.rendered).toBe(false)
    expect(r.text.length).toBeGreaterThan(1000)
    expect(r.structured.meta.title).toBe('Rich Static Page')
    expect(r.structured.og.title).toBe('Rich Static')
    expect(r.structured.jsonld).toHaveLength(1)
    expect(r.structured.headings.h1).toEqual(['Hello'])
    expect(r.structured.robots).toContain('User-agent')
    expect(r.structured.sitemap.present).toBe(false)
    expect(r.structured.llmsTxt.present).toBe(false)
  }, 30_000)

  it('SPA page: rendered=true, text extracted after client script fills the DOM', async () => {
    const r = await scrape(`${base}/spa`)
    expect(r.rendered).toBe(true)
    expect(r.text).toContain('client-rendered content')
  }, 30_000)
})
```

- [ ] **Step 2: Run the integration test**

Run:
```bash
pnpm test:integration tests/integration/scraper.test.ts
```

Expected: both cases pass. First run may take ~20s (Chromium cold start); subsequent runs ~5–10s.

- [ ] **Step 3: Run the full integration suite**

Run:
```bash
pnpm test:integration
```

Expected: Plan 1's integration tests (`healthz`, `queues`, `redis`, `store`, `worker`) still pass alongside the new scraper test.

- [ ] **Step 4: Run the full unit suite**

Run:
```bash
pnpm test
```

Expected: all unit tests pass (Plan 1 + Plan 2).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/scraper.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "test(scraper): integration — real Playwright against local fixture server"
```

---

## Task 11 — Final verification

**Files:** none (verification only).

- [ ] **Step 1: Clean typecheck**

Run:
```bash
pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 2: Clean unit test run**

Run:
```bash
pnpm test
```

Expected: all tests pass; no new skips or warnings.

- [ ] **Step 3: Clean integration test run**

Run:
```bash
pnpm test:integration
```

Expected: all tests pass, including both scraper integration cases.

- [ ] **Step 4: Clean build**

Run:
```bash
pnpm build
```

Expected: `dist/server.js` and `dist/worker.js` present, no tsup errors.

- [ ] **Step 5: Smoke-check the worker shutdown**

Run:
```bash
pnpm dev:worker
```

In another terminal, send SIGTERM:
```bash
pkill -TERM -f dist/worker.js || pkill -TERM -f "tsx watch src/worker/worker.ts"
```

Expected: the dev worker logs clean shutdown — Redis closed, DB closed, Chromium closed (if the pool was ever initialized; on a fresh boot the pool is lazy, so "Browser pool never started" is also acceptable). No stray `chromium_headless_shell` processes left in `ps`.

If stray processes remain, that's a regression in `shutdownBrowserPool()` and must be fixed before marking Task 11 complete.

---

## Traceability — spec §6 coverage

| Spec requirement | Task |
|---|---|
| §6.1 plain fetch with 10s timeout | Task 5 |
| §6.1 fallback when visible text < 1000 chars | Task 8, Task 10 |
| §6.1 Playwright with networkidle | Task 7, Task 10 |
| §6.1 final output shape | Task 2 (types), Task 8 (composition) |
| §6.2 extractJsonLd | Task 4 |
| §6.2 extractOG | Task 4 |
| §6.2 extractMeta | Task 4 |
| §6.2 extractHeadings | Task 4 |
| §6.2 fetchRobots | Task 6 |
| §6.2 fetchSitemap | Task 6 |
| §6.2 fetchLlmsTxt | Task 6 |
| §6.3 single shared Chromium, max 2 pages, 15s timeout | Task 7 |
| §6.3 on timeout fall through with plain-fetch result, rendered=false | Task 8 (keeps static on render failure) |
| Plan 1 footgun: shutdown new long-lived resources | Task 7 step 3 (worker SIGTERM handler) |

---

## Out-of-scope reminders (do not do these)

- Do not add a `POST /grades` route — that's Plan 6.
- Do not call `GradeStore.createScrape` from anywhere in `src/scraper/` — persistence is Plan 5's job.
- Do not extend the `GradeStore` interface — `createScrape` / `getScrape` already exist.
- Do not modify `src/db/schema.ts` — the `scrapes` table shape is already correct.
- Do not add LLM providers, prompts, or anything in `src/core/` — that's Plan 4.
- Do not add new env vars — scraper is URL-in, data-out; no config needed.
