# GEO Reporter Plan 3 — SEO Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a library-only `src/seo/` module that takes a `ScrapeResult` from Plan 2 and returns a composite SEO score with per-signal pass/fail/detail breakdown, per the 10-signal rubric in spec §5.4.

**Architecture:** Pure synchronous functions. One file per signal under `src/seo/signals/`, each exporting a function `(scrape: ScrapeResult) => SignalResult`. `src/seo/index.ts` composes all 10 into `evaluateSeo(scrape) => { score, signals }`. No I/O, no DB, no LLMs, no HTTP — everything derives from fields the Plan 2 scraper already produced (`structured.jsonld`, `structured.og`, `structured.meta`, `structured.headings`, `structured.robots`, `structured.sitemap`, `structured.llmsTxt`). Plan 5 is responsible for persisting each SignalResult as a `probes` row with `category='seo'`, `provider=null`.

**Tech Stack:** TypeScript 5.6+ strict, vitest 2 unit tests, `robots-parser` (new runtime dep) for the robots.txt user-agent check. No Playwright, no DB, no network at test time.

---

## Spec references

- Source of truth: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` §5.4 (SEO rubric).
- Interpretation calls locked in at spec amendment `e116f31` (2026-04-17):
  - Title "non-generic" = case-insensitive exact-match blacklist (`home`, `index`, `untitled`, `welcome`, `default`).
  - Missing robots.txt (null) counts as pass — permissive default.
  - JSON-LD check traverses `@graph` wrappers; matches `Organization`, `Product`, or `WebSite`.
  - Use `robots-parser` npm for robots.txt matching.

---

## File Structure

```
src/seo/
├── types.ts                    — SignalResult, SeoResult, SIGNAL_WEIGHT constant
├── signals/
│   ├── title.ts                — <title> exists, trimmed, not in generic blacklist
│   ├── description.ts          — meta description present, ≥ 50 chars trimmed
│   ├── canonical.ts            — <link rel=canonical> present
│   ├── twitter-card.ts         — meta twitter:card present
│   ├── open-graph.ts           — og:title + og:description + og:image all present
│   ├── jsonld.ts               — any @type in {Organization, Product, WebSite}, incl. @graph
│   ├── robots.ts               — robots-parser: GPTBot/ClaudeBot/PerplexityBot allowed on /
│   ├── sitemap.ts              — scrape.structured.sitemap.present
│   ├── llms-txt.ts             — scrape.structured.llmsTxt.present
│   └── headings.ts             — h1.length === 1 AND h2.length >= 1
└── index.ts                    — evaluateSeo(scrape) composite scorer

tests/unit/seo/
├── signals/
│   ├── title.test.ts
│   ├── description.test.ts
│   ├── canonical.test.ts
│   ├── twitter-card.test.ts
│   ├── open-graph.test.ts
│   ├── jsonld.test.ts
│   ├── robots.test.ts
│   ├── sitemap.test.ts
│   ├── llms-txt.test.ts
│   └── headings.test.ts
└── index.test.ts               — composite scoring math
```

**Why one file per signal:** spec §4.2 rationale ("for testability") + each file is small, single-responsibility, and testable in isolation. 10 tiny focused files beat one 200-line sprawl.

**Signal name IDs** (used in `SignalResult.name`, stable for future `probes.metadata.signal` mapping):
`title`, `description`, `canonical`, `twitter-card`, `open-graph`, `jsonld`, `robots`, `sitemap`, `llms-txt`, `headings`.

---

## Dependencies to add

| Package | Role | Kind |
|---|---|---|
| `robots-parser` | Parse robots.txt; `isAllowed(url, userAgent)` with Allow-vs-Disallow precedence | runtime |

Ships its own TypeScript types (no `@types/robots-parser` needed as of v3).

---

## Project constraints (from CLAUDE.md)

- `.ts` import extensions everywhere.
- `import type` for type-only imports (`verbatimModuleSyntax: true`).
- `exactOptionalPropertyTypes: true` — when building SignalResult, always include every field with a real value (never `undefined`).
- Store seam preserved: SEO module does not import `src/store/**`, `src/db/**`, `src/queue/**`, or make any HTTP calls.
- Inline git identity for every commit: `git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit ...`.
- Tests live in `tests/unit/seo/**`, picked up by `pnpm test` (unit config `include: tests/unit/**`).

---

## Task 1 — Dependencies and public types

**Files:**
- Modify: `package.json` (add dep)
- Create: `src/seo/types.ts`

- [ ] **Step 1: Add runtime dependency**

Run:
```bash
pnpm add robots-parser@^3.0.1
```

Expected: `robots-parser` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Create types file**

Create `src/seo/types.ts`:
```ts
export const SIGNAL_WEIGHT = 10

export type SignalName =
  | 'title'
  | 'description'
  | 'canonical'
  | 'twitter-card'
  | 'open-graph'
  | 'jsonld'
  | 'robots'
  | 'sitemap'
  | 'llms-txt'
  | 'headings'

export interface SignalResult {
  name: SignalName
  pass: boolean
  weight: number
  detail: string
}

export interface SeoResult {
  score: number
  signals: SignalResult[]
}
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/seo/types.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(seo): add robots-parser dep and public types"
```

---

## Task 2 — Meta-presence signals (title, description, canonical, twitter-card)

Four small, independent signals that all check for the presence (and in one case, length) of a `meta.*` field on the ScrapeResult. Grouped into one task because each is ~5 lines; keeping them separate would be overhead without clarity gain.

**Files:**
- Test: `tests/unit/seo/signals/title.test.ts`
- Test: `tests/unit/seo/signals/description.test.ts`
- Test: `tests/unit/seo/signals/canonical.test.ts`
- Test: `tests/unit/seo/signals/twitter-card.test.ts`
- Create: `src/seo/signals/title.ts`
- Create: `src/seo/signals/description.ts`
- Create: `src/seo/signals/canonical.ts`
- Create: `src/seo/signals/twitter-card.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/seo/signals/title.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateTitle } from '../../../../src/seo/signals/title.ts'

function makeScrape(title: string | undefined): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
      meta: title === undefined ? {} : { title },
    },
  }
}

describe('evaluateTitle', () => {
  it('passes for a specific, non-generic title', () => {
    const r = evaluateTitle(makeScrape('Acme Widgets — Industrial-Grade Sprockets'))
    expect(r).toMatchObject({ name: 'title', pass: true, weight: 10 })
  })

  it('fails when title is missing', () => {
    const r = evaluateTitle(makeScrape(undefined))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('missing')
  })

  it('fails for exact-match "Home" (case-insensitive)', () => {
    expect(evaluateTitle(makeScrape('Home')).pass).toBe(false)
    expect(evaluateTitle(makeScrape('home')).pass).toBe(false)
    expect(evaluateTitle(makeScrape('  HOME  ')).pass).toBe(false)
  })

  it('fails for other exact-match blacklist entries', () => {
    for (const generic of ['index', 'untitled', 'welcome', 'default']) {
      expect(evaluateTitle(makeScrape(generic)).pass).toBe(false)
    }
  })

  it('passes for titles that contain a generic word but are not equal to it', () => {
    expect(evaluateTitle(makeScrape('Home | Acme Widgets')).pass).toBe(true)
    expect(evaluateTitle(makeScrape('Welcome to Our Site')).pass).toBe(true)
  })
})
```

Create `tests/unit/seo/signals/description.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateDescription } from '../../../../src/seo/signals/description.ts'

function makeScrape(description: string | undefined): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
      meta: description === undefined ? {} : { description },
    },
  }
}

describe('evaluateDescription', () => {
  it('passes when description is exactly 50 chars', () => {
    const r = evaluateDescription(makeScrape('x'.repeat(50)))
    expect(r.pass).toBe(true)
  })

  it('passes when description is longer than 50 chars', () => {
    const r = evaluateDescription(makeScrape('x'.repeat(120)))
    expect(r.pass).toBe(true)
  })

  it('fails when description is missing', () => {
    const r = evaluateDescription(makeScrape(undefined))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('missing')
  })

  it('fails when description is under 50 chars, and reports the length', () => {
    const r = evaluateDescription(makeScrape('x'.repeat(49)))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('49')
    expect(r.detail).toContain('50')
  })

  it('fails when description is only whitespace', () => {
    const r = evaluateDescription(makeScrape('                                                      '))
    // whitespace-only should be treated as missing-ish after trim
    expect(r.pass).toBe(false)
  })
})
```

Create `tests/unit/seo/signals/canonical.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateCanonical } from '../../../../src/seo/signals/canonical.ts'

function makeScrape(canonical: string | undefined): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
      meta: canonical === undefined ? {} : { canonical },
    },
  }
}

describe('evaluateCanonical', () => {
  it('passes when canonical link is present', () => {
    expect(evaluateCanonical(makeScrape('https://acme.example/')).pass).toBe(true)
  })

  it('fails when canonical link is missing', () => {
    const r = evaluateCanonical(makeScrape(undefined))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('missing')
  })
})
```

Create `tests/unit/seo/signals/twitter-card.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateTwitterCard } from '../../../../src/seo/signals/twitter-card.ts'

function makeScrape(twitterCard: string | undefined): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
      meta: twitterCard === undefined ? {} : { twitterCard },
    },
  }
}

describe('evaluateTwitterCard', () => {
  it('passes when twitter:card is present (summary)', () => {
    expect(evaluateTwitterCard(makeScrape('summary')).pass).toBe(true)
  })

  it('passes for summary_large_image', () => {
    expect(evaluateTwitterCard(makeScrape('summary_large_image')).pass).toBe(true)
  })

  it('fails when twitter:card is missing', () => {
    const r = evaluateTwitterCard(makeScrape(undefined))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('twitter:card')
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
```bash
pnpm vitest run tests/unit/seo/signals
```

Expected: FAIL — all four signal modules not found yet.

- [ ] **Step 3: Write the implementations**

Create `src/seo/signals/title.ts`:
```ts
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const GENERIC_TITLES = new Set(['home', 'index', 'untitled', 'welcome', 'default'])

export function evaluateTitle(scrape: ScrapeResult): SignalResult {
  const raw = scrape.structured.meta.title
  if (raw === undefined || raw.trim().length === 0) {
    return { name: 'title', pass: false, weight: SIGNAL_WEIGHT, detail: '<title> is missing' }
  }
  const normalized = raw.trim().toLowerCase()
  if (GENERIC_TITLES.has(normalized)) {
    return { name: 'title', pass: false, weight: SIGNAL_WEIGHT, detail: `<title> is too generic: "${raw.trim()}"` }
  }
  return { name: 'title', pass: true, weight: SIGNAL_WEIGHT, detail: `<title> is "${raw.trim()}"` }
}
```

Create `src/seo/signals/description.ts`:
```ts
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const MIN_LENGTH = 50

export function evaluateDescription(scrape: ScrapeResult): SignalResult {
  const raw = scrape.structured.meta.description
  if (raw === undefined || raw.trim().length === 0) {
    return { name: 'description', pass: false, weight: SIGNAL_WEIGHT, detail: 'meta description is missing' }
  }
  const length = raw.trim().length
  if (length < MIN_LENGTH) {
    return {
      name: 'description',
      pass: false,
      weight: SIGNAL_WEIGHT,
      detail: `meta description is too short (${length} chars, need ≥ ${MIN_LENGTH})`,
    }
  }
  return { name: 'description', pass: true, weight: SIGNAL_WEIGHT, detail: `meta description is ${length} chars` }
}
```

Create `src/seo/signals/canonical.ts`:
```ts
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateCanonical(scrape: ScrapeResult): SignalResult {
  const raw = scrape.structured.meta.canonical
  if (raw === undefined || raw.trim().length === 0) {
    return { name: 'canonical', pass: false, weight: SIGNAL_WEIGHT, detail: '<link rel="canonical"> is missing' }
  }
  return { name: 'canonical', pass: true, weight: SIGNAL_WEIGHT, detail: `canonical → ${raw.trim()}` }
}
```

Create `src/seo/signals/twitter-card.ts`:
```ts
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateTwitterCard(scrape: ScrapeResult): SignalResult {
  const raw = scrape.structured.meta.twitterCard
  if (raw === undefined || raw.trim().length === 0) {
    return { name: 'twitter-card', pass: false, weight: SIGNAL_WEIGHT, detail: 'twitter:card meta is missing' }
  }
  return { name: 'twitter-card', pass: true, weight: SIGNAL_WEIGHT, detail: `twitter:card = "${raw.trim()}"` }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
pnpm vitest run tests/unit/seo/signals
```

Expected: all four test files green, 14+ tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/seo/signals/title.ts src/seo/signals/description.ts src/seo/signals/canonical.ts src/seo/signals/twitter-card.ts \
        tests/unit/seo/signals/title.test.ts tests/unit/seo/signals/description.test.ts tests/unit/seo/signals/canonical.test.ts tests/unit/seo/signals/twitter-card.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(seo): title, description, canonical, twitter-card signals"
```

---

## Task 3 — Open Graph signal (TDD)

Checks three specific OG fields are present together and names which are missing when they aren't.

**Files:**
- Test: `tests/unit/seo/signals/open-graph.test.ts`
- Create: `src/seo/signals/open-graph.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/seo/signals/open-graph.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import type { OpenGraph } from '../../../../src/scraper/index.ts'
import { evaluateOpenGraph } from '../../../../src/seo/signals/open-graph.ts'

function makeScrape(og: OpenGraph): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og, meta: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateOpenGraph', () => {
  it('passes when title, description, and image are all present', () => {
    const r = evaluateOpenGraph(makeScrape({
      title: 'Acme',
      description: 'Things we make',
      image: 'https://img.example/og.png',
    }))
    expect(r).toMatchObject({ name: 'open-graph', pass: true, weight: 10 })
  })

  it('fails and names the missing fields when some are absent', () => {
    const r = evaluateOpenGraph(makeScrape({ title: 'Acme' }))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('og:description')
    expect(r.detail).toContain('og:image')
    expect(r.detail).not.toContain('og:title')
  })

  it('fails and lists all three when none are present', () => {
    const r = evaluateOpenGraph(makeScrape({}))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('og:title')
    expect(r.detail).toContain('og:description')
    expect(r.detail).toContain('og:image')
  })

  it('treats empty-string values as missing', () => {
    const r = evaluateOpenGraph(makeScrape({
      title: '',
      description: '',
      image: '',
    }))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('og:title')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/seo/signals/open-graph.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/seo/signals/open-graph.ts`:
```ts
import type { ScrapeResult, OpenGraph } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const REQUIRED: Array<{ key: keyof OpenGraph; label: string }> = [
  { key: 'title', label: 'og:title' },
  { key: 'description', label: 'og:description' },
  { key: 'image', label: 'og:image' },
]

export function evaluateOpenGraph(scrape: ScrapeResult): SignalResult {
  const og = scrape.structured.og
  const missing: string[] = []
  for (const { key, label } of REQUIRED) {
    const v = og[key]
    if (v === undefined || v.trim().length === 0) missing.push(label)
  }
  if (missing.length === 0) {
    return { name: 'open-graph', pass: true, weight: SIGNAL_WEIGHT, detail: 'og:title, og:description, og:image all present' }
  }
  return {
    name: 'open-graph',
    pass: false,
    weight: SIGNAL_WEIGHT,
    detail: `missing: ${missing.join(', ')}`,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/seo/signals/open-graph.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/seo/signals/open-graph.ts tests/unit/seo/signals/open-graph.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(seo): open-graph signal (title + description + image)"
```

---

## Task 4 — JSON-LD signal with @graph traversal (TDD)

Passes if any `@type` in the JSON-LD blocks (top-level, in an array, or nested in a `@graph`) matches `Organization`, `Product`, or `WebSite`. `@type` can itself be a string or an array of strings.

**Files:**
- Test: `tests/unit/seo/signals/jsonld.test.ts`
- Create: `src/seo/signals/jsonld.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/seo/signals/jsonld.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateJsonLd } from '../../../../src/seo/signals/jsonld.ts'

function makeScrape(jsonld: unknown[]): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld, og: {}, meta: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateJsonLd', () => {
  it('passes for a top-level @type: Organization', () => {
    const r = evaluateJsonLd(makeScrape([{ '@type': 'Organization', name: 'Acme' }]))
    expect(r).toMatchObject({ name: 'jsonld', pass: true, weight: 10 })
  })

  it('passes for @type: Product', () => {
    expect(evaluateJsonLd(makeScrape([{ '@type': 'Product' }])).pass).toBe(true)
  })

  it('passes for @type: WebSite', () => {
    expect(evaluateJsonLd(makeScrape([{ '@type': 'WebSite' }])).pass).toBe(true)
  })

  it('passes when @type is an array containing Organization', () => {
    expect(evaluateJsonLd(makeScrape([{ '@type': ['Thing', 'Organization'] }])).pass).toBe(true)
  })

  it('passes when Organization is nested inside @graph', () => {
    expect(evaluateJsonLd(makeScrape([{
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'BreadcrumbList' }, { '@type': 'Organization' }],
    }])).pass).toBe(true)
  })

  it('passes when one of multiple blocks is Organization', () => {
    expect(evaluateJsonLd(makeScrape([
      { '@type': 'BreadcrumbList' },
      { '@type': 'Organization' },
    ])).pass).toBe(true)
  })

  it('fails when jsonld array is empty', () => {
    const r = evaluateJsonLd(makeScrape([]))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('No JSON-LD')
  })

  it('fails when no @type matches the allowed set', () => {
    const r = evaluateJsonLd(makeScrape([{ '@type': 'Article' }, { '@type': 'BreadcrumbList' }]))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('Article')
  })

  it('fails gracefully on malformed block shapes', () => {
    const r = evaluateJsonLd(makeScrape(['just a string', 42, null, { noType: true }]))
    expect(r.pass).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/seo/signals/jsonld.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/seo/signals/jsonld.ts`:
```ts
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const ALLOWED_TYPES = new Set(['Organization', 'Product', 'WebSite'])

function collectTypes(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const t = obj['@type']
  if (typeof t === 'string') out.add(t)
  else if (Array.isArray(t)) {
    for (const x of t) if (typeof x === 'string') out.add(x)
  }
  const graph = obj['@graph']
  if (Array.isArray(graph)) {
    for (const child of graph) collectTypes(child, out)
  }
}

export function evaluateJsonLd(scrape: ScrapeResult): SignalResult {
  const blocks = scrape.structured.jsonld
  if (blocks.length === 0) {
    return { name: 'jsonld', pass: false, weight: SIGNAL_WEIGHT, detail: 'No JSON-LD found' }
  }
  const typesSeen = new Set<string>()
  for (const block of blocks) {
    if (Array.isArray(block)) {
      for (const child of block) collectTypes(child, typesSeen)
    } else {
      collectTypes(block, typesSeen)
    }
  }
  for (const t of typesSeen) {
    if (ALLOWED_TYPES.has(t)) {
      return { name: 'jsonld', pass: true, weight: SIGNAL_WEIGHT, detail: `JSON-LD @type includes "${t}"` }
    }
  }
  const seen = [...typesSeen].join(', ') || '(none)'
  return {
    name: 'jsonld',
    pass: false,
    weight: SIGNAL_WEIGHT,
    detail: `JSON-LD @type seen: ${seen}; expected Organization, Product, or WebSite`,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/seo/signals/jsonld.test.ts
```

Expected: 9/9 pass.

- [ ] **Step 5: Commit**

```bash
git add src/seo/signals/jsonld.ts tests/unit/seo/signals/jsonld.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(seo): jsonld signal with @graph traversal and @type array support"
```

---

## Task 5 — Robots signal with robots-parser (TDD)

Passes if `robots` content is `null` (404, permissive) OR robots-parser says all of `GPTBot`, `ClaudeBot`, `PerplexityBot` are allowed at `/`. Lists blocked user-agents in the detail on fail.

**Files:**
- Test: `tests/unit/seo/signals/robots.test.ts`
- Create: `src/seo/signals/robots.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/seo/signals/robots.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateRobots } from '../../../../src/seo/signals/robots.ts'

function makeScrape(robots: string | null): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] },
      robots,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateRobots', () => {
  it('passes when robots.txt is absent (null)', () => {
    const r = evaluateRobots(makeScrape(null))
    expect(r).toMatchObject({ name: 'robots', pass: true, weight: 10 })
    expect(r.detail).toMatch(/absent|permissive/i)
  })

  it('passes when all LLM bots are allowed by explicit allow-all', () => {
    expect(evaluateRobots(makeScrape('User-agent: *\nAllow: /')).pass).toBe(true)
  })

  it('passes when a specific path is disallowed but / is still allowed', () => {
    expect(evaluateRobots(makeScrape('User-agent: *\nDisallow: /private/')).pass).toBe(true)
  })

  it('fails when GPTBot is specifically disallowed from /', () => {
    const r = evaluateRobots(makeScrape('User-agent: GPTBot\nDisallow: /'))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('GPTBot')
  })

  it('fails and lists all three bots when * disallows /', () => {
    const r = evaluateRobots(makeScrape('User-agent: *\nDisallow: /'))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('GPTBot')
    expect(r.detail).toContain('ClaudeBot')
    expect(r.detail).toContain('PerplexityBot')
  })

  it('reports only the specific bot when one is blocked and others are allowed', () => {
    const txt = 'User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /'
    const r = evaluateRobots(makeScrape(txt))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('ClaudeBot')
    expect(r.detail).not.toContain('GPTBot')
    expect(r.detail).not.toContain('PerplexityBot')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/seo/signals/robots.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/seo/signals/robots.ts`:
```ts
import robotsParser from 'robots-parser'
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

const TRACKED_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot'] as const

// Synthetic origin used only so robots-parser has a consistent URL base to
// reason about. The Plan 2 ScrapeResult doesn't carry the input URL (yet),
// and robots-parser's isAllowed logic only cares about path matching within
// the same origin, so any consistent origin works.
const SYNTHETIC_ROBOTS_URL = 'http://site.invalid/robots.txt'
const SYNTHETIC_ROOT_URL = 'http://site.invalid/'

export function evaluateRobots(scrape: ScrapeResult): SignalResult {
  const content = scrape.structured.robots
  if (content === null) {
    return {
      name: 'robots',
      pass: true,
      weight: SIGNAL_WEIGHT,
      detail: 'robots.txt absent (permissive default)',
    }
  }
  const robots = robotsParser(SYNTHETIC_ROBOTS_URL, content)
  const blocked: string[] = []
  for (const bot of TRACKED_BOTS) {
    const allowed = robots.isAllowed(SYNTHETIC_ROOT_URL, bot)
    if (allowed === false) blocked.push(bot)
  }
  if (blocked.length === 0) {
    return {
      name: 'robots',
      pass: true,
      weight: SIGNAL_WEIGHT,
      detail: 'robots.txt allows GPTBot, ClaudeBot, PerplexityBot',
    }
  }
  return {
    name: 'robots',
    pass: false,
    weight: SIGNAL_WEIGHT,
    detail: `robots.txt blocks: ${blocked.join(', ')}`,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/seo/signals/robots.test.ts
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/seo/signals/robots.ts tests/unit/seo/signals/robots.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(seo): robots signal with robots-parser for LLM bot allow-check"
```

---

## Task 6 — Scrape-state signals (sitemap, llms-txt, headings)

Three signals whose input comes entirely from `scrape.structured` fields already populated by Plan 2's scraper. Grouped together because each is trivial (one boolean or two integer comparisons) and they share a common "read state, return SignalResult" pattern.

**Files:**
- Test: `tests/unit/seo/signals/sitemap.test.ts`
- Test: `tests/unit/seo/signals/llms-txt.test.ts`
- Test: `tests/unit/seo/signals/headings.test.ts`
- Create: `src/seo/signals/sitemap.ts`
- Create: `src/seo/signals/llms-txt.ts`
- Create: `src/seo/signals/headings.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/seo/signals/sitemap.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateSitemap } from '../../../../src/seo/signals/sitemap.ts'

function makeScrape(present: boolean): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present, url: 'https://acme.example/sitemap.xml' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateSitemap', () => {
  it('passes when sitemap.xml is reachable', () => {
    expect(evaluateSitemap(makeScrape(true)).pass).toBe(true)
  })
  it('fails when sitemap.xml is not reachable', () => {
    const r = evaluateSitemap(makeScrape(false))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('sitemap.xml')
  })
})
```

Create `tests/unit/seo/signals/llms-txt.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateLlmsTxt } from '../../../../src/seo/signals/llms-txt.ts'

function makeScrape(present: boolean): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present, url: 'https://acme.example/llms.txt' },
    },
  }
}

describe('evaluateLlmsTxt', () => {
  it('passes when llms.txt is reachable', () => {
    expect(evaluateLlmsTxt(makeScrape(true)).pass).toBe(true)
  })
  it('fails when llms.txt is not reachable', () => {
    const r = evaluateLlmsTxt(makeScrape(false))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('llms.txt')
  })
})
```

Create `tests/unit/seo/signals/headings.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../../src/scraper/index.ts'
import { evaluateHeadings } from '../../../../src/seo/signals/headings.ts'

function makeScrape(h1: string[], h2: string[]): ScrapeResult {
  return {
    rendered: false, html: '', text: '',
    structured: {
      jsonld: [], og: {}, meta: {}, headings: { h1, h2 },
      robots: null,
      sitemap: { present: false, url: '' },
      llmsTxt: { present: false, url: '' },
    },
  }
}

describe('evaluateHeadings', () => {
  it('passes with exactly one h1 and at least one h2', () => {
    expect(evaluateHeadings(makeScrape(['Main'], ['A'])).pass).toBe(true)
    expect(evaluateHeadings(makeScrape(['Main'], ['A', 'B', 'C'])).pass).toBe(true)
  })
  it('fails when no h1 is present', () => {
    const r = evaluateHeadings(makeScrape([], ['A']))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('<h1>')
  })
  it('fails when multiple h1 tags are present', () => {
    const r = evaluateHeadings(makeScrape(['A', 'B'], ['C']))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('2')
  })
  it('fails when no h2 is present', () => {
    const r = evaluateHeadings(makeScrape(['Main'], []))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('<h2>')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm vitest run tests/unit/seo/signals/sitemap.test.ts tests/unit/seo/signals/llms-txt.test.ts tests/unit/seo/signals/headings.test.ts
```

Expected: FAIL — three modules not found.

- [ ] **Step 3: Write the implementations**

Create `src/seo/signals/sitemap.ts`:
```ts
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateSitemap(scrape: ScrapeResult): SignalResult {
  const present = scrape.structured.sitemap.present
  return {
    name: 'sitemap',
    pass: present,
    weight: SIGNAL_WEIGHT,
    detail: present ? 'sitemap.xml reachable' : 'sitemap.xml not reachable',
  }
}
```

Create `src/seo/signals/llms-txt.ts`:
```ts
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateLlmsTxt(scrape: ScrapeResult): SignalResult {
  const present = scrape.structured.llmsTxt.present
  return {
    name: 'llms-txt',
    pass: present,
    weight: SIGNAL_WEIGHT,
    detail: present ? 'llms.txt reachable' : 'llms.txt not reachable',
  }
}
```

Create `src/seo/signals/headings.ts`:
```ts
import type { ScrapeResult } from '../../scraper/index.ts'
import type { SignalResult } from '../types.ts'
import { SIGNAL_WEIGHT } from '../types.ts'

export function evaluateHeadings(scrape: ScrapeResult): SignalResult {
  const { h1, h2 } = scrape.structured.headings
  if (h1.length === 0) {
    return { name: 'headings', pass: false, weight: SIGNAL_WEIGHT, detail: 'no <h1> present' }
  }
  if (h1.length > 1) {
    return { name: 'headings', pass: false, weight: SIGNAL_WEIGHT, detail: `multiple <h1> tags (${h1.length} found)` }
  }
  if (h2.length === 0) {
    return { name: 'headings', pass: false, weight: SIGNAL_WEIGHT, detail: 'no <h2> present' }
  }
  return {
    name: 'headings',
    pass: true,
    weight: SIGNAL_WEIGHT,
    detail: `1 <h1> and ${h2.length} <h2> tag${h2.length === 1 ? '' : 's'}`,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
pnpm vitest run tests/unit/seo/signals
```

Expected: all signal test files green (including Tasks 2–5's tests).

- [ ] **Step 5: Commit**

```bash
git add src/seo/signals/sitemap.ts src/seo/signals/llms-txt.ts src/seo/signals/headings.ts \
        tests/unit/seo/signals/sitemap.test.ts tests/unit/seo/signals/llms-txt.test.ts tests/unit/seo/signals/headings.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(seo): sitemap, llms-txt, headings scrape-state signals"
```

---

## Task 7 — Composite evaluator + re-export + final verification (TDD)

Wires the 10 signals together, computes the weighted score, and exposes `evaluateSeo` from the package root.

**Files:**
- Test: `tests/unit/seo/index.test.ts`
- Create: `src/seo/index.ts`
- Modify: `src/index.ts` (add re-exports)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/seo/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { ScrapeResult } from '../../../src/scraper/index.ts'
import { evaluateSeo } from '../../../src/seo/index.ts'

const allGood: ScrapeResult = {
  rendered: false, html: '', text: '',
  structured: {
    jsonld: [{ '@type': 'Organization' }],
    og: { title: 'A', description: 'B', image: 'C' },
    meta: {
      title: 'Acme Widgets',
      description: 'A'.repeat(60),
      canonical: 'https://acme.example/',
      twitterCard: 'summary_large_image',
    },
    headings: { h1: ['Hello'], h2: ['Details'] },
    robots: 'User-agent: *\nAllow: /',
    sitemap: { present: true, url: 'https://acme.example/sitemap.xml' },
    llmsTxt: { present: true, url: 'https://acme.example/llms.txt' },
  },
}

const allBad: ScrapeResult = {
  rendered: false, html: '', text: '',
  structured: {
    jsonld: [],
    og: {},
    meta: {},
    headings: { h1: [], h2: [] },
    robots: 'User-agent: *\nDisallow: /',
    sitemap: { present: false, url: '' },
    llmsTxt: { present: false, url: '' },
  },
}

describe('evaluateSeo', () => {
  it('returns 10 signals in stable order', () => {
    const r = evaluateSeo(allGood)
    expect(r.signals).toHaveLength(10)
    expect(r.signals.map((s) => s.name)).toEqual([
      'title', 'description', 'canonical', 'twitter-card',
      'open-graph', 'jsonld',
      'robots', 'sitemap', 'llms-txt',
      'headings',
    ])
  })

  it('scores 100 when every signal passes', () => {
    const r = evaluateSeo(allGood)
    expect(r.score).toBe(100)
    expect(r.signals.every((s) => s.pass)).toBe(true)
  })

  it('scores 0 when every signal fails', () => {
    const r = evaluateSeo(allBad)
    expect(r.score).toBe(0)
    expect(r.signals.every((s) => !s.pass)).toBe(true)
  })

  it('scores 50 when exactly half the signals pass', () => {
    const half: ScrapeResult = {
      ...allBad,
      structured: {
        ...allBad.structured,
        // 5 pass: title, description, canonical, twitter-card, open-graph
        meta: {
          title: 'Acme Widgets',
          description: 'A'.repeat(60),
          canonical: 'https://acme.example/',
          twitterCard: 'summary',
        },
        og: { title: 'A', description: 'B', image: 'C' },
      },
    }
    const r = evaluateSeo(half)
    expect(r.score).toBe(50)
    expect(r.signals.filter((s) => s.pass)).toHaveLength(5)
  })

  it('score is rounded to the nearest integer', () => {
    // 7/10 = 70 (integer already — exercise the rounding code path with a near-edge case)
    const seven: ScrapeResult = {
      ...allBad,
      structured: {
        ...allBad.structured,
        meta: {
          title: 'Acme Widgets',
          description: 'A'.repeat(60),
          canonical: 'https://acme.example/',
          twitterCard: 'summary',
        },
        og: { title: 'A', description: 'B', image: 'C' },
        jsonld: [{ '@type': 'Organization' }],
        sitemap: { present: true, url: 'https://acme.example/sitemap.xml' },
      },
    }
    const r = evaluateSeo(seven)
    expect(r.score).toBe(70)
    expect(Number.isInteger(r.score)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm vitest run tests/unit/seo/index.test.ts
```

Expected: FAIL — `src/seo/index.ts` not found.

- [ ] **Step 3: Write the composite**

Create `src/seo/index.ts`:
```ts
import type { ScrapeResult } from '../scraper/index.ts'
import type { SeoResult, SignalResult } from './types.ts'
import { evaluateTitle } from './signals/title.ts'
import { evaluateDescription } from './signals/description.ts'
import { evaluateCanonical } from './signals/canonical.ts'
import { evaluateTwitterCard } from './signals/twitter-card.ts'
import { evaluateOpenGraph } from './signals/open-graph.ts'
import { evaluateJsonLd } from './signals/jsonld.ts'
import { evaluateRobots } from './signals/robots.ts'
import { evaluateSitemap } from './signals/sitemap.ts'
import { evaluateLlmsTxt } from './signals/llms-txt.ts'
import { evaluateHeadings } from './signals/headings.ts'

export type { SignalResult, SeoResult, SignalName } from './types.ts'
export { SIGNAL_WEIGHT } from './types.ts'

export function evaluateSeo(scrape: ScrapeResult): SeoResult {
  const signals: SignalResult[] = [
    evaluateTitle(scrape),
    evaluateDescription(scrape),
    evaluateCanonical(scrape),
    evaluateTwitterCard(scrape),
    evaluateOpenGraph(scrape),
    evaluateJsonLd(scrape),
    evaluateRobots(scrape),
    evaluateSitemap(scrape),
    evaluateLlmsTxt(scrape),
    evaluateHeadings(scrape),
  ]
  const totalWeight = signals.reduce((s, x) => s + x.weight, 0)
  const passedWeight = signals.filter((s) => s.pass).reduce((s, x) => s + x.weight, 0)
  const score = totalWeight === 0 ? 0 : Math.round((passedWeight / totalWeight) * 100)
  return { score, signals }
}
```

- [ ] **Step 4: Run the composite test to verify it passes**

Run:
```bash
pnpm vitest run tests/unit/seo/index.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 5: Add re-exports to `src/index.ts`**

Read `src/index.ts` first. Append these lines at the end (preserve every existing line):
```ts
export { evaluateSeo, SIGNAL_WEIGHT } from './seo/index.ts'
export type { SeoResult, SignalResult, SignalName } from './seo/index.ts'
```

- [ ] **Step 6: Final verification — typecheck, full unit suite, build**

Run:
```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected:
- `pnpm typecheck`: no errors.
- `pnpm test`: all unit tests pass (Plan 1 + Plan 2 + Plan 3). Roughly 40 pre-existing + ~40 new SEO unit tests = ~80 total.
- `pnpm build`: `dist/server.js` and `dist/worker.js` present, no tsup errors.

- [ ] **Step 7: Commit**

```bash
git add src/seo/index.ts src/index.ts tests/unit/seo/index.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' \
  commit -m "feat(seo): composite evaluateSeo + package re-exports"
```

---

## Traceability — spec §5.4 coverage

| Spec signal | File | Task |
|---|---|---|
| `<title>` present and non-generic | `src/seo/signals/title.ts` | 2 |
| meta description ≥ 50 chars | `src/seo/signals/description.ts` | 2 |
| `<link rel=canonical>` present | `src/seo/signals/canonical.ts` | 2 |
| `twitter:card` present | `src/seo/signals/twitter-card.ts` | 2 |
| Open Graph title + description + image | `src/seo/signals/open-graph.ts` | 3 |
| JSON-LD @type ∈ {Organization, Product, WebSite} | `src/seo/signals/jsonld.ts` | 4 |
| robots.txt doesn't disallow GPTBot/ClaudeBot/PerplexityBot | `src/seo/signals/robots.ts` | 5 |
| sitemap.xml reachable | `src/seo/signals/sitemap.ts` | 6 |
| llms.txt reachable | `src/seo/signals/llms-txt.ts` | 6 |
| Exactly 1 h1 + ≥ 1 h2 | `src/seo/signals/headings.ts` | 6 |
| Composite score = passed_weight / total_weight × 100 | `src/seo/index.ts` | 7 |
| Spec interpretation: title exact-match blacklist | Task 2 test + impl | 2 |
| Spec interpretation: robots 404 = pass | Task 5 test + impl | 5 |
| Spec interpretation: JSON-LD @graph traversal | Task 4 test + impl | 4 |
| robots-parser library choice | Task 1 + Task 5 | 1, 5 |

---

## Out-of-scope reminders

- Do not write `probes` rows from inside `src/seo/`. Plan 5 maps `SignalResult` → `NewProbe` and persists.
- Do not import anything from `src/store/`, `src/db/`, `src/queue/`, or `src/scraper/`'s internal files. Only `src/scraper/index.ts` types are allowed (public surface).
- Do not make HTTP calls in `src/seo/`. All data comes from the `ScrapeResult` input. Plan 2 already ran the network fetches.
- Do not add recommendations ("Add og:image — your homepage has none"). Recommendations are Plan 8's LLM output; signal `detail` is only diagnostic.
- Do not add new env vars. SEO evaluation is pure input-in, result-out.
- Do not modify `src/scraper/` or `src/scraper/types.ts` — the `ScrapeResult` shape is the input contract. If Plan 5 later needs a URL field on `ScrapeResult`, that change belongs in its own plan.
