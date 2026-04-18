# GEO Reporter Plan 5 — Grade Pipeline Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the BullMQ `run-grade` worker that wires Plans 2 (scraper), 3 (SEO), and 4 (scoring engine) into a full grade pipeline — from an enqueued `{ gradeId, tier }` job to a finalized `grades` row + populated `probes` + SSE-ready Redis events on `grade:<id>`.

**Architecture:** One worker module under `src/queue/workers/run-grade/`, a shared pub/sub helper in `src/queue/events.ts`, and a dev CLI script. All LLM, DB, and Redis access flows through an injected `RunGradeDeps` object so unit tests can run the full pipeline with `MockProvider` + an in-memory `GradeStore` fake + a stub Redis. Integration tests use testcontainers (Postgres + Redis) with `MockProvider` — no real LLM calls anywhere in Plan 5.

**Tech Stack:** TypeScript 5.6+ strict, vitest 2 (unit + integration configs), BullMQ 5, ioredis 5, testcontainers 10, Drizzle ORM 0.33. No new runtime deps. No new dev deps.

---

## Spec references

- Sub-spec (source of truth): `docs/superpowers/specs/2026-04-17-geo-reporter-plan-5-grade-pipeline-design.md`
- Master spec: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` §4.3 (end-to-end trace — free grade), amended with Plan 5 anchor at commit `287dfce`.

**Interpretation calls locked in (sub-spec §2, brainstormed 2026-04-17):**

- P5-1: Ship `scripts/enqueue-grade.ts` dev CLI.
- P5-2: Publisher AND subscriber together in `src/queue/events.ts`.
- P5-3: Claude plays judge, accuracy generator, and accuracy verifier.
- P5-4: Write-through persistence with `DELETE` on retry.
- P5-5: SEO serial first, then 5 LLM categories in parallel.
- P5-6: Per-probe SSE events (`probe.started`, `probe.completed`, `category.completed`, lifecycle events).
- P5-7: Accuracy = 1 generator row + N answer rows; Coverage = 2N rows with per-probe judge scoring; `provider=null` reserved for SEO signals + accuracy-skipped placeholders.
- P5-8: Always-finalize; hard-fail only on DB/Redis down, scrape < 100 chars, or total LLM failure.

---

## File structure

```
src/
├── config/env.ts                                MODIFY — tighten API-key fields to required in production
├── queue/
│   ├── events.ts                                NEW — GradeEvent union + publish + subscribe helpers
│   └── workers/
│       ├── health.ts                            (existing)
│       └── run-grade/                           NEW
│           ├── deps.ts                            RunGradeDeps interface + GradeFailure error class
│           ├── categories.ts                     collapseToCategoryScore + 6 runXxxCategory adapters
│           ├── run-grade.ts                      runGrade(job, deps) — the Processor function
│           └── index.ts                          registerRunGradeWorker(deps, connection)
├── store/
│   ├── postgres.ts                              MODIFY — add clearGradeArtifacts
│   └── types.ts                                 MODIFY — add clearGradeArtifacts to GradeStore interface
└── worker/worker.ts                             MODIFY — build deps + register run-grade worker

scripts/
└── enqueue-grade.ts                             NEW — dev CLI

package.json                                     MODIFY — add enqueue-grade script

tests/unit/
├── queue/
│   └── workers/run-grade/
│       ├── categories.test.ts                    collapseToCategoryScore + category-adapter unit tests
│       └── run-grade.test.ts                     Processor with fake deps

tests/integration/
├── events.test.ts                                NEW — pub/sub roundtrip
└── run-grade.test.ts                             NEW — full end-to-end with testcontainers + MockProvider
```

---

## Project constraints (from CLAUDE.md)

- `.ts` extensions on ALL imports (`allowImportingTsExtensions: true` + `noEmit: true`).
- `import type` for type-only imports (`verbatimModuleSyntax: true`).
- `exactOptionalPropertyTypes: true` — conditionally assign optional fields; never spread `undefined`.
- `noUncheckedIndexedAccess: true` — `arr[0]` is `T | undefined`.
- Store seam: worker DB writes go through `GradeStore` only.
- Git commits use inline identity: `git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit …` — NEVER touch global config.
- Unit tests land in `tests/unit/**` (picked up by `pnpm test`).
- Integration tests land in `tests/integration/**` (picked up by `pnpm test:integration` — testcontainers + 60s timeouts).

---

## Task 1 — `GradeStore.clearGradeArtifacts`

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/postgres.ts`
- Create: `tests/integration/store-clear-artifacts.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/store-clear-artifacts.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => {
  testDb = await startTestDb()
  store = new PostgresStore(testDb.db)
}, 60_000)

afterAll(async () => {
  await testDb.stop()
})

describe('PostgresStore.clearGradeArtifacts', () => {
  it('deletes scrape and probes rows for the given gradeId', async () => {
    const cookie = await store.upsertCookie('cookie-clear-1')
    const grade = await store.createGrade({
      url: 'https://example.com', domain: 'example.com', tier: 'free',
      cookie: cookie.cookie, status: 'running',
    })
    await store.createScrape({
      gradeId: grade.id, rendered: false, html: '<html/>', text: 'x',
      structured: { jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] }, robots: null, sitemap: { present: false, url: '' }, llmsTxt: { present: false, url: '' } },
    })
    await store.createProbe({ gradeId: grade.id, category: 'seo', provider: null, prompt: 'title', response: 'pass', score: 100, metadata: {} })
    await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'claude', prompt: 'q', response: 'r', score: 70, metadata: {} })

    await store.clearGradeArtifacts(grade.id)

    const scrape = await store.getScrape(grade.id)
    const probes = await store.listProbes(grade.id)
    expect(scrape).toBeNull()
    expect(probes).toHaveLength(0)
  })

  it('does not touch other grades artifacts', async () => {
    const cookie = await store.upsertCookie('cookie-clear-2')
    const a = await store.createGrade({ url: 'https://a.com', domain: 'a.com', tier: 'free', cookie: cookie.cookie, status: 'running' })
    const b = await store.createGrade({ url: 'https://b.com', domain: 'b.com', tier: 'free', cookie: cookie.cookie, status: 'running' })
    await store.createProbe({ gradeId: a.id, category: 'seo', provider: null, prompt: 'x', response: 'y', score: 100, metadata: {} })
    await store.createProbe({ gradeId: b.id, category: 'seo', provider: null, prompt: 'x', response: 'y', score: 100, metadata: {} })

    await store.clearGradeArtifacts(a.id)

    expect(await store.listProbes(a.id)).toHaveLength(0)
    expect(await store.listProbes(b.id)).toHaveLength(1)
  })

  it('is a no-op when the grade has no artifacts', async () => {
    const cookie = await store.upsertCookie('cookie-clear-3')
    const grade = await store.createGrade({ url: 'https://c.com', domain: 'c.com', tier: 'free', cookie: cookie.cookie, status: 'queued' })
    await expect(store.clearGradeArtifacts(grade.id)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration tests/integration/store-clear-artifacts.test.ts`
Expected: FAIL — `store.clearGradeArtifacts is not a function`.

- [ ] **Step 3: Add method signature to `GradeStore` interface**

Modify `src/store/types.ts`. After the existing `getScrape` method, add:
```ts
  // Worker retry helper: atomically deletes scrape + probe rows for one grade.
  clearGradeArtifacts(gradeId: string): Promise<void>
```

- [ ] **Step 4: Implement `clearGradeArtifacts` in `PostgresStore`**

Modify `src/store/postgres.ts`. Add the `eq` → `and` import, then the method. The imports line at top needs `eq` (already there). Then add this method anywhere (e.g. after `getScrape`):

```ts
  async clearGradeArtifacts(gradeId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.probes).where(eq(schema.probes.gradeId, gradeId))
      await tx.delete(schema.scrapes).where(eq(schema.scrapes.gradeId, gradeId))
    })
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:integration tests/integration/store-clear-artifacts.test.ts`
Expected: PASS (3 tests).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/store/types.ts src/store/postgres.ts tests/integration/store-clear-artifacts.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): GradeStore.clearGradeArtifacts for worker retry clean-slate"
```

---

## Task 2 — Pub/sub helpers (`src/queue/events.ts`)

**Files:**
- Create: `src/queue/events.ts`
- Create: `tests/integration/events.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/events.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { createRedis } from '../../src/queue/redis.ts'
import { publishGradeEvent, subscribeToGrade, type GradeEvent } from '../../src/queue/events.ts'

let container: StartedTestContainer
let redisUrl: string

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
}, 60_000)

afterAll(async () => {
  await container.stop()
})

async function collect(iter: AsyncIterable<GradeEvent>, count: number, timeoutMs = 2000): Promise<GradeEvent[]> {
  const out: GradeEvent[] = []
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))
  for await (const ev of iter) {
    out.push(ev)
    if (out.length >= count) break
    if ((await Promise.race([Promise.resolve('cont'), timer])) === 'timeout') break
  }
  return out
}

describe('publishGradeEvent + subscribeToGrade', () => {
  it('round-trips a running event', async () => {
    const publisher = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const gradeId = 'g-1'

    const received: Promise<GradeEvent[]> = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, gradeId)) {
        out.push(ev)
        if (ev.type === 'done' || ev.type === 'failed') break
      }
      return out
    })()

    await new Promise((r) => setTimeout(r, 50)) // give subscriber time to register
    await publishGradeEvent(publisher, gradeId, { type: 'running' })
    await publishGradeEvent(publisher, gradeId, { type: 'done', overall: 80, letter: 'B', scores: { discoverability: 80, recognition: null, accuracy: null, coverage: null, citation: null, seo: null } })

    const events = await received
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('running')
    expect(events[1]?.type).toBe('done')

    await publisher.quit()
    await subscriber.quit()
  })

  it('terminates the iterator on done', async () => {
    const publisher = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const gradeId = 'g-2'

    const pending = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, gradeId)) {
        out.push(ev)
      }
      return out
    })()

    await new Promise((r) => setTimeout(r, 50))
    await publishGradeEvent(publisher, gradeId, { type: 'scraped', rendered: false, textLength: 1200 })
    await publishGradeEvent(publisher, gradeId, { type: 'done', overall: 70, letter: 'C', scores: { discoverability: 70, recognition: null, accuracy: null, coverage: null, citation: null, seo: null } })

    const events = await pending
    expect(events).toHaveLength(2)

    await publisher.quit()
    await subscriber.quit()
  })

  it('terminates the iterator on failed', async () => {
    const publisher = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const gradeId = 'g-3'

    const pending = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, gradeId)) out.push(ev)
      return out
    })()

    await new Promise((r) => setTimeout(r, 50))
    await publishGradeEvent(publisher, gradeId, { type: 'failed', error: 'boom' })
    const events = await pending
    expect(events).toEqual([{ type: 'failed', error: 'boom' }])

    await publisher.quit()
    await subscriber.quit()
  })

  it('terminates the iterator when AbortSignal fires', async () => {
    const publisher = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const gradeId = 'g-4'
    const ctrl = new AbortController()

    const pending = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, gradeId, ctrl.signal)) out.push(ev)
      return out
    })()

    await new Promise((r) => setTimeout(r, 50))
    await publishGradeEvent(publisher, gradeId, { type: 'running' })
    await new Promise((r) => setTimeout(r, 50))
    ctrl.abort()
    const events = await pending
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('running')

    await publisher.quit()
    await subscriber.quit()
  })

  it('delivers events to multiple subscribers on the same gradeId', async () => {
    const publisher = createRedis(redisUrl)
    const sub1 = createRedis(redisUrl)
    const sub2 = createRedis(redisUrl)
    const gradeId = 'g-5'

    const results = [
      (async () => { const out: GradeEvent[] = []; for await (const ev of subscribeToGrade(sub1, gradeId)) { out.push(ev); if (ev.type === 'done') break } return out })(),
      (async () => { const out: GradeEvent[] = []; for await (const ev of subscribeToGrade(sub2, gradeId)) { out.push(ev); if (ev.type === 'done') break } return out })(),
    ]

    await new Promise((r) => setTimeout(r, 100))
    await publishGradeEvent(publisher, gradeId, { type: 'scraped', rendered: true, textLength: 5000 })
    await publishGradeEvent(publisher, gradeId, { type: 'done', overall: 90, letter: 'A-', scores: { discoverability: null, recognition: null, accuracy: null, coverage: null, citation: null, seo: 90 } })

    const [a, b] = await Promise.all(results)
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)

    await publisher.quit()
    await sub1.quit()
    await sub2.quit()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration tests/integration/events.test.ts`
Expected: FAIL — module `../../src/queue/events.ts` does not exist.

- [ ] **Step 3: Implement `src/queue/events.ts`**

```ts
import type Redis from 'ioredis'
import type { ProviderId } from '../llm/providers/types.ts'
import type { CategoryId } from '../scoring/weights.ts'

export type GradeEvent =
  | { type: 'running' }
  | { type: 'scraped'; rendered: boolean; textLength: number }
  | { type: 'probe.started'; category: CategoryId; provider: ProviderId | null; label: string }
  | {
      type: 'probe.completed'
      category: CategoryId
      provider: ProviderId | null
      label: string
      score: number | null
      durationMs: number
      error: string | null
    }
  | { type: 'category.completed'; category: CategoryId; score: number | null }
  | { type: 'done'; overall: number; letter: string; scores: Record<CategoryId, number | null> }
  | { type: 'failed'; error: string }

export function channelFor(gradeId: string): string {
  return `grade:${gradeId}`
}

export async function publishGradeEvent(
  redis: Redis,
  gradeId: string,
  event: GradeEvent,
): Promise<void> {
  await redis.publish(channelFor(gradeId), JSON.stringify(event))
}

export function subscribeToGrade(
  redis: Redis,
  gradeId: string,
  signal?: AbortSignal,
): AsyncIterable<GradeEvent> {
  const channel = channelFor(gradeId)
  return {
    [Symbol.asyncIterator](): AsyncIterator<GradeEvent> {
      const queue: GradeEvent[] = []
      let waiter: ((ev: IteratorResult<GradeEvent>) => void) | null = null
      let done = false

      const finish = (): void => {
        if (done) return
        done = true
        void redis.unsubscribe(channel).catch(() => undefined)
        redis.removeListener('message', onMessage)
        if (waiter) {
          waiter({ value: undefined, done: true })
          waiter = null
        }
      }

      const onMessage = (ch: string, payload: string): void => {
        if (ch !== channel) return
        let event: GradeEvent
        try {
          event = JSON.parse(payload) as GradeEvent
        } catch {
          return
        }
        if (waiter) {
          const w = waiter
          waiter = null
          w({ value: event, done: false })
        } else {
          queue.push(event)
        }
        if (event.type === 'done' || event.type === 'failed') finish()
      }

      redis.on('message', onMessage)
      void redis.subscribe(channel).catch(() => finish())

      if (signal) {
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      }

      return {
        next(): Promise<IteratorResult<GradeEvent>> {
          if (queue.length > 0) {
            const v = queue.shift() as GradeEvent
            return Promise.resolve({ value: v, done: false })
          }
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiter = resolve
          })
        },
        return(): Promise<IteratorResult<GradeEvent>> {
          finish()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:integration tests/integration/events.test.ts`
Expected: PASS (5 tests).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/events.ts tests/integration/events.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): grade-event pub/sub helpers"
```

---

## Task 3 — RunGradeDeps + GradeFailure

**Files:**
- Create: `src/queue/workers/run-grade/deps.ts`

- [ ] **Step 1: Create `src/queue/workers/run-grade/deps.ts`**

```ts
import type Redis from 'ioredis'
import type { DirectProviders } from '../../../llm/providers/factory.ts'
import type { ScrapeResult } from '../../../scraper/index.ts'
import type { GradeStore } from '../../../store/types.ts'

export interface RunGradeDeps {
  store: GradeStore
  redis: Redis
  providers: DirectProviders
  scrapeFn: (url: string) => Promise<ScrapeResult>
  now?: () => number
}

export class GradeFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GradeFailure'
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: clean. No tests for this task — it's just types + an error class; behavior covered by downstream tasks.

- [ ] **Step 3: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/deps.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): RunGradeDeps + GradeFailure skeleton"
```

---

## Task 4 — `collapseToCategoryScore`

**Files:**
- Create: `src/queue/workers/run-grade/categories.ts`
- Create: `tests/unit/queue/workers/run-grade/categories.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/queue/workers/run-grade/categories.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { collapseToCategoryScore } from '../../../../../src/queue/workers/run-grade/categories.ts'

describe('collapseToCategoryScore', () => {
  it('returns rounded mean for all-number input', () => {
    expect(collapseToCategoryScore([80, 90, 70])).toBe(80)
  })
  it('ignores nulls and averages the rest', () => {
    expect(collapseToCategoryScore([null, 80, null, 100])).toBe(90)
  })
  it('returns null when all entries are null', () => {
    expect(collapseToCategoryScore([null, null])).toBeNull()
  })
  it('returns null for empty array', () => {
    expect(collapseToCategoryScore([])).toBeNull()
  })
  it('rounds .5 half away from zero (JS Math.round)', () => {
    expect(collapseToCategoryScore([50, 51])).toBe(51)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/queue/workers/run-grade/categories.ts`**

```ts
export function collapseToCategoryScore(scores: (number | null)[]): number | null {
  const numeric = scores.filter((s): s is number => s !== null)
  if (numeric.length === 0) return null
  return Math.round(numeric.reduce((a, b) => a + b, 0) / numeric.length)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/categories.ts tests/unit/queue/workers/run-grade/categories.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): collapseToCategoryScore helper"
```

---

## Shared test fixtures (referenced by Tasks 5–10)

The unit tests for category adapters and the Processor need an in-memory `GradeStore` fake and a stub Redis. Define these once as local helpers inside each test file (duplicate is simpler than a shared fixture module for ~6 small adapters). The shapes are:

**In-memory fake store** (use in each test file that needs one):
```ts
import type { GradeStore, Grade, Probe, Scrape, NewGrade, NewProbe, NewScrape, GradeUpdate, User, Cookie, Recommendation, NewRecommendation, Report, NewReport } from '../../../../../src/store/types.ts'

function makeFakeStore(seed: { grades?: Grade[] } = {}): GradeStore & {
  grades: Map<string, Grade>
  scrapes: Map<string, Scrape>
  probes: Probe[]
  clearedFor: string[]
} {
  const grades = new Map<string, Grade>()
  for (const g of seed.grades ?? []) grades.set(g.id, g)
  const scrapes = new Map<string, Scrape>()
  const probes: Probe[] = []
  const clearedFor: string[] = []

  return {
    grades, scrapes, probes, clearedFor,

    async createGrade(input: NewGrade): Promise<Grade> {
      const id = input.id ?? crypto.randomUUID()
      const now = new Date()
      const g: Grade = {
        id, url: input.url, domain: input.domain, tier: input.tier,
        cookie: input.cookie ?? null, userId: input.userId ?? null,
        status: input.status ?? 'queued', overall: input.overall ?? null,
        letter: input.letter ?? null, scores: input.scores ?? null,
        createdAt: now, updatedAt: now,
      }
      grades.set(id, g)
      return g
    },
    async getGrade(id: string): Promise<Grade | null> { return grades.get(id) ?? null },
    async updateGrade(id: string, patch: GradeUpdate): Promise<void> {
      const g = grades.get(id)
      if (!g) return
      grades.set(id, { ...g, ...patch, updatedAt: new Date() })
    },
    async createProbe(input: NewProbe): Promise<Probe> {
      const p: Probe = {
        id: crypto.randomUUID(), gradeId: input.gradeId, category: input.category,
        provider: input.provider ?? null, prompt: input.prompt, response: input.response,
        score: input.score ?? null, metadata: input.metadata ?? {}, createdAt: new Date(),
      }
      probes.push(p)
      return p
    },
    async listProbes(gradeId: string): Promise<Probe[]> { return probes.filter((p) => p.gradeId === gradeId) },
    async createScrape(input: NewScrape): Promise<Scrape> {
      const s: Scrape = {
        id: crypto.randomUUID(), gradeId: input.gradeId, rendered: input.rendered ?? false,
        html: input.html, text: input.text, structured: input.structured,
        fetchedAt: input.fetchedAt ?? new Date(),
      }
      scrapes.set(input.gradeId, s)
      return s
    },
    async getScrape(gradeId: string): Promise<Scrape | null> { return scrapes.get(gradeId) ?? null },
    async clearGradeArtifacts(gradeId: string): Promise<void> {
      clearedFor.push(gradeId)
      scrapes.delete(gradeId)
      for (let i = probes.length - 1; i >= 0; i--) if (probes[i]?.gradeId === gradeId) probes.splice(i, 1)
    },
    async upsertUser(email: string): Promise<User> { return { id: crypto.randomUUID(), email, createdAt: new Date() } },
    async upsertCookie(cookie: string, userId?: string): Promise<Cookie> { return { cookie, userId: userId ?? null, createdAt: new Date() } },
    async createRecommendations(_rows: NewRecommendation[]): Promise<void> {},
    async listRecommendations(_gradeId: string): Promise<Recommendation[]> { return [] },
    async createReport(input: NewReport): Promise<Report> { return { id: crypto.randomUUID(), gradeId: input.gradeId, token: input.token, createdAt: new Date() } },
    async getReport(_gradeId: string): Promise<Report | null> { return null },
  }
}
```

**Stub Redis** (records `.publish()` calls, no real pub/sub):
```ts
import type Redis from 'ioredis'

function makeStubRedis(): Redis & { published: { channel: string; message: string }[] } {
  const published: { channel: string; message: string }[] = []
  const stub = {
    published,
    async publish(channel: string, message: string): Promise<number> {
      published.push({ channel, message })
      return 1
    },
  }
  return stub as unknown as Redis & { published: { channel: string; message: string }[] }
}
```

**Parse published events** (for assertions):
```ts
import type { GradeEvent } from '../../../../../src/queue/events.ts'

function parseEvents(redis: { published: { channel: string; message: string }[] }, gradeId: string): GradeEvent[] {
  return redis.published
    .filter((p) => p.channel === `grade:${gradeId}`)
    .map((p) => JSON.parse(p.message) as GradeEvent)
}
```

Each test file in Tasks 5–10 duplicates these helpers inline (they're ~80 lines but shared-fixture coupling is a bigger long-term cost).

---

## Task 5 — `runSeoCategory` adapter

**Files:**
- Modify: `src/queue/workers/run-grade/categories.ts`
- Modify: `tests/unit/queue/workers/run-grade/categories.test.ts`

- [ ] **Step 1: Append failing test for `runSeoCategory`**

Add to `tests/unit/queue/workers/run-grade/categories.test.ts` (include the shared helpers at the top of the file or inline; see "Shared test fixtures" above):

```ts
import { runSeoCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'
import type { ScrapeResult } from '../../../../../src/scraper/index.ts'

const SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: 'body text of the site with enough content for scoring signals to evaluate properly.',
  structured: {
    jsonld: [],
    og: { title: 'Acme', description: 'We sell widgets', image: 'https://acme.com/og.png' },
    meta: { title: 'Acme Widgets', description: 'We sell the best widgets on the market, made with premium materials since 1902.', canonical: 'https://acme.com', twitterCard: 'summary' },
    headings: { h1: ['Welcome to Acme'], h2: ['About us'] },
    robots: null,
    sitemap: { present: true, url: 'https://acme.com/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
  },
}

describe('runSeoCategory', () => {
  it('writes 10 probe rows (one per signal), all with provider=null', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const score = await runSeoCategory({ gradeId: 'g1', scrape: SCRAPE, deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const seoProbes = store.probes.filter((p) => p.category === 'seo')
    expect(seoProbes).toHaveLength(10)
    expect(seoProbes.every((p) => p.provider === null)).toBe(true)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('emits probe.completed per signal + category.completed', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await runSeoCategory({ gradeId: 'g1', scrape: SCRAPE, deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const events = parseEvents(redis, 'g1')
    const probeCompletions = events.filter((e) => e.type === 'probe.completed' && e.category === 'seo')
    const cat = events.find((e) => e.type === 'category.completed' && e.category === 'seo')
    expect(probeCompletions).toHaveLength(10)
    expect(cat).toBeDefined()
  })

  it('returns the score from evaluateSeo (not collapsed per-signal)', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const score = await runSeoCategory({ gradeId: 'g1', scrape: SCRAPE, deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })
    // evaluateSeo returns score = round(passedWeight / totalWeight * 100). Just assert plausible.
    expect(score).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: FAIL — `runSeoCategory` not exported.

- [ ] **Step 3: Append `runSeoCategory` to `src/queue/workers/run-grade/categories.ts`**

```ts
import { evaluateSeo, SIGNAL_WEIGHT } from '../../../seo/index.ts'
import type { ScrapeResult } from '../../../scraper/index.ts'
import type { RunGradeDeps } from './deps.ts'
import { publishGradeEvent } from '../events.ts'

export interface CategoryArgs {
  gradeId: string
  scrape: ScrapeResult
  deps: RunGradeDeps
}

export async function runSeoCategory(args: CategoryArgs): Promise<number> {
  const { gradeId, scrape, deps } = args
  const result = evaluateSeo(scrape)

  for (const signal of result.signals) {
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.started', category: 'seo', provider: null, label: signal.name,
    })
    await deps.store.createProbe({
      gradeId, category: 'seo', provider: null,
      prompt: signal.name, response: signal.detail,
      score: signal.pass ? SIGNAL_WEIGHT * 10 : 0,
      metadata: { signal: signal.name, pass: signal.pass, weight: signal.weight },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category: 'seo', provider: null, label: signal.name,
      score: signal.pass ? SIGNAL_WEIGHT * 10 : 0, durationMs: 0, error: null,
    })
  }

  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'seo', score: result.score })
  return result.score
}
```

**Note:** The `probe.score` value here is `SIGNAL_WEIGHT * 10` (=100) on pass vs 0 on fail — per-signal probe rows store a pass/fail integer, but the category-level score comes from `evaluateSeo`'s composite directly. This gives reports two views: per-signal pass/fail (the probe rows) and the aggregate SEO score (the `grades.scores.seo` column).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: PASS (previous tests + 3 new = 8 tests).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/categories.ts tests/unit/queue/workers/run-grade/categories.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): runSeoCategory adapter"
```

---

## Task 6 — Recognition + Citation adapters

**Files:**
- Modify: `src/queue/workers/run-grade/categories.ts`
- Modify: `tests/unit/queue/workers/run-grade/categories.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/unit/queue/workers/run-grade/categories.test.ts`:

```ts
import { runRecognitionCategory, runCitationCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'
import { MockProvider } from '../../../../../src/llm/providers/mock.ts'
import type { Grade } from '../../../../../src/store/types.ts'

const GRADE: Grade = {
  id: 'g-rec', url: 'https://stripe.com', domain: 'stripe.com', tier: 'free',
  cookie: null, userId: null, status: 'running',
  overall: null, letter: null, scores: null,
  createdAt: new Date(), updatedAt: new Date(),
}

describe('runRecognitionCategory', () => {
  it('runs 2 prompts × N providers and writes 2N probe rows', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Stripe is a leading payment processor founded in 2010, used by millions of businesses worldwide.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Stripe is a payment service.' })
    const score = await runRecognitionCategory({ gradeId: 'g-rec', grade: GRADE, probers: [claude, gpt], deps: { store, redis, providers: {} as never, scrapeFn: async () => ({}) as never } })

    const rows = store.probes.filter((p) => p.category === 'recognition')
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.provider).sort()).toEqual(['claude', 'claude', 'gpt', 'gpt'])
    expect(score).not.toBeNull()
  })

  it('records error in metadata when a provider throws; score is null for that probe', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Stripe is a leading payment processor.' })
    const broken = new MockProvider({ id: 'gpt', responses: {}, failWith: 'rate limit' })
    await runRecognitionCategory({ gradeId: 'g-rec', grade: GRADE, probers: [claude, broken], deps: { store, redis, providers: {} as never, scrapeFn: async () => ({}) as never } })

    const brokenRows = store.probes.filter((p) => p.category === 'recognition' && p.provider === 'gpt')
    expect(brokenRows).toHaveLength(2)
    expect(brokenRows.every((r) => r.score === null)).toBe(true)
    expect(brokenRows.every((r) => (r.metadata as { error?: string }).error === 'rate limit')).toBe(true)
  })

  it('returns null score when every provider fails for every prompt', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const a = new MockProvider({ id: 'claude', responses: {}, failWith: 'down' })
    const b = new MockProvider({ id: 'gpt', responses: {}, failWith: 'down' })
    const score = await runRecognitionCategory({ gradeId: 'g-rec', grade: GRADE, probers: [a, b], deps: { store, redis, providers: {} as never, scrapeFn: async () => ({}) as never } })
    expect(score).toBeNull()
  })

  it('emits category.completed with the collapsed score', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Stripe is the leading payment processor used worldwide by millions, founded in 2010.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Stripe is a leading payment processor used globally.' })
    const score = await runRecognitionCategory({ gradeId: 'g-rec', grade: GRADE, probers: [claude, gpt], deps: { store, redis, providers: {} as never, scrapeFn: async () => ({}) as never } })

    const events = parseEvents(redis, 'g-rec')
    const cat = events.find((e) => e.type === 'category.completed' && e.category === 'recognition')
    expect(cat).toBeDefined()
    if (cat?.type === 'category.completed') expect(cat.score).toBe(score)
  })
})

describe('runCitationCategory', () => {
  it('runs 1 prompt per provider and writes N probe rows', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Visit https://stripe.com' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'See stripe.com' })
    const score = await runCitationCategory({ gradeId: 'g-cit', grade: { ...GRADE, id: 'g-cit', url: 'https://stripe.com' }, probers: [claude, gpt], deps: { store, redis, providers: {} as never, scrapeFn: async () => ({}) as never } })

    const rows = store.probes.filter((p) => p.category === 'citation')
    expect(rows).toHaveLength(2)
    expect(score).toBe(75) // round((100 + 50) / 2) = 75
  })

  it('records error on provider failure', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const broken = new MockProvider({ id: 'claude', responses: {}, failWith: 'timeout' })
    await runCitationCategory({ gradeId: 'g-cit', grade: { ...GRADE, id: 'g-cit' }, probers: [broken], deps: { store, redis, providers: {} as never, scrapeFn: async () => ({}) as never } })

    const rows = store.probes.filter((p) => p.category === 'citation')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.score).toBeNull()
    expect((rows[0]?.metadata as { error?: string }).error).toBe('timeout')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: FAIL — `runRecognitionCategory` / `runCitationCategory` not exported.

- [ ] **Step 3: Append adapters to `src/queue/workers/run-grade/categories.ts`**

Add these imports to the existing import block at the top:
```ts
import { promptRecognition, promptCitation } from '../../../llm/prompts.ts'
import { runStaticProbe } from '../../../llm/flows/static-probe.ts'
import { scoreRecognition } from '../../../scoring/recognition.ts'
import { scoreCitation } from '../../../scoring/citation.ts'
import type { Provider } from '../../../llm/providers/types.ts'
import type { Grade } from '../../../store/types.ts'
```

Then append:
```ts
export interface ProberCategoryArgs extends CategoryArgs {
  grade: Grade
  probers: Provider[]
}

export async function runRecognitionCategory(args: ProberCategoryArgs): Promise<number | null> {
  const { gradeId, grade, probers, deps } = args
  const [promptA, promptB] = promptRecognition(grade.domain)
  const probeScores: (number | null)[] = []

  for (const provider of probers) {
    for (const [prompt, label] of [[promptA, 'prompt_1'], [promptB, 'prompt_2']] as const) {
      probeScores.push(await runOneHeuristicProbe({
        gradeId, category: 'recognition', provider, prompt, label, deps,
        scorer: (text) => ({ score: scoreRecognition({ text, domain: grade.domain }), rationale: 'recognition heuristic v1' }),
      }))
    }
  }

  const score = collapseToCategoryScore(probeScores)
  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'recognition', score })
  return score
}

export async function runCitationCategory(args: ProberCategoryArgs): Promise<number | null> {
  const { gradeId, grade, probers, deps } = args
  const prompt = promptCitation(grade.domain)
  const probeScores: (number | null)[] = []

  for (const provider of probers) {
    probeScores.push(await runOneHeuristicProbe({
      gradeId, category: 'citation', provider, prompt, label: 'official-url', deps,
      scorer: (text) => ({ score: scoreCitation({ text, domain: grade.domain }), rationale: 'citation heuristic v1' }),
    }))
  }

  const score = collapseToCategoryScore(probeScores)
  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'citation', score })
  return score
}

interface HeuristicProbeArgs {
  gradeId: string
  category: 'recognition' | 'citation'
  provider: Provider
  prompt: string
  label: string
  deps: RunGradeDeps
  scorer: (text: string) => { score: number; rationale: string }
}

async function runOneHeuristicProbe(a: HeuristicProbeArgs): Promise<number | null> {
  const { gradeId, category, provider, prompt, label, deps, scorer } = a
  await publishGradeEvent(deps.redis, gradeId, { type: 'probe.started', category, provider: provider.id, label })
  const start = Date.now()
  try {
    const r = await runStaticProbe({ provider, prompt, scorer })
    await deps.store.createProbe({
      gradeId, category, provider: provider.id, prompt: r.prompt, response: r.response,
      score: r.score, metadata: { label, latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, rationale: r.scoreRationale },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category, provider: provider.id, label,
      score: r.score, durationMs: Date.now() - start, error: null,
    })
    return r.score
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await deps.store.createProbe({
      gradeId, category, provider: provider.id, prompt, response: '',
      score: null, metadata: { label, error },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category, provider: provider.id, label,
      score: null, durationMs: Date.now() - start, error,
    })
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: PASS (~14 tests total).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/categories.ts tests/unit/queue/workers/run-grade/categories.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): Recognition + Citation category adapters"
```

---

## Task 7 — Discoverability adapter

**Files:**
- Modify: `src/queue/workers/run-grade/categories.ts`
- Modify: `tests/unit/queue/workers/run-grade/categories.test.ts`

- [ ] **Step 1: Append failing test**

Append to `tests/unit/queue/workers/run-grade/categories.test.ts`:

```ts
import { runDiscoverabilityCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'

describe('runDiscoverabilityCategory', () => {
  it('runs self-gen flow per provider and writes N probe rows', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({
      id: 'claude',
      responses: (prompt) => prompt.includes('Do NOT reference')
        ? 'What is the best payment processor?'
        : 'Stripe is the leading payment processor used worldwide.',
    })
    const gpt = new MockProvider({
      id: 'gpt',
      responses: (prompt) => prompt.includes('Do NOT reference')
        ? 'Which payment platform is the industry standard?'
        : 'Stripe is the industry standard for payments.',
    })
    const score = await runDiscoverabilityCategory({ gradeId: 'g-disc', grade: { ...GRADE, id: 'g-disc' }, probers: [claude, gpt], deps: { store, redis, providers: {} as never, scrapeFn: async () => ({}) as never } })

    const rows = store.probes.filter((p) => p.category === 'discoverability')
    expect(rows).toHaveLength(2) // one per provider (self-gen is atomic)
    expect(rows.every((r) => (r.metadata as { generator?: unknown }).generator !== undefined)).toBe(true)
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('records error on provider failure', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const broken = new MockProvider({ id: 'claude', responses: {}, failWith: 'down' })
    const score = await runDiscoverabilityCategory({ gradeId: 'g-disc', grade: { ...GRADE, id: 'g-disc' }, probers: [broken], deps: { store, redis, providers: {} as never, scrapeFn: async () => ({}) as never } })
    expect(score).toBeNull()
    const rows = store.probes.filter((p) => p.category === 'discoverability')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.score).toBeNull()
    expect((rows[0]?.metadata as { error?: string }).error).toBe('down')
  })
})
```

**Important:** `runDiscoverabilityCategory` needs a `scrape` because it reads from `ScrapeResult` → `GroundTruth`. The test uses `SCRAPE` defined in Task 5's test block. Add `scrape: SCRAPE` to the args in each test call — update both tests above:
```ts
await runDiscoverabilityCategory({ gradeId, grade, scrape: SCRAPE, probers, deps })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: FAIL — `runDiscoverabilityCategory` not exported.

- [ ] **Step 3: Append adapter to `src/queue/workers/run-grade/categories.ts`**

Add imports:
```ts
import { runSelfGenProbe } from '../../../llm/flows/self-gen.ts'
import { scoreDiscoverability } from '../../../scoring/discoverability.ts'
import { toGroundTruth } from '../../../llm/ground-truth.ts'
```

Then append:
```ts
export interface ScrapedCategoryArgs extends ProberCategoryArgs {
  scrape: ScrapeResult
}

export async function runDiscoverabilityCategory(args: ScrapedCategoryArgs): Promise<number | null> {
  const { gradeId, grade, scrape, probers, deps } = args
  const gt = toGroundTruth(grade.url, scrape)
  const probeScores: (number | null)[] = []

  for (const provider of probers) {
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.started', category: 'discoverability', provider: provider.id, label: 'self-gen',
    })
    const start = Date.now()
    try {
      const r = await runSelfGenProbe({
        provider, groundTruth: gt,
        scorer: ({ text, brand, domain }) => scoreDiscoverability({ text, brand, domain }),
      })
      await deps.store.createProbe({
        gradeId, category: 'discoverability', provider: provider.id,
        prompt: r.probe.prompt, response: r.probe.response, score: r.score,
        metadata: {
          label: 'self-gen',
          generator: { prompt: r.generator.prompt, response: r.generator.response, latencyMs: r.generator.latencyMs, inputTokens: r.generator.inputTokens, outputTokens: r.generator.outputTokens },
          latencyMs: r.probe.latencyMs, inputTokens: r.probe.inputTokens, outputTokens: r.probe.outputTokens,
          rationale: r.scoreRationale,
        },
      })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'probe.completed', category: 'discoverability', provider: provider.id, label: 'self-gen',
        score: r.score, durationMs: Date.now() - start, error: null,
      })
      probeScores.push(r.score)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await deps.store.createProbe({
        gradeId, category: 'discoverability', provider: provider.id,
        prompt: '', response: '', score: null, metadata: { label: 'self-gen', error },
      })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'probe.completed', category: 'discoverability', provider: provider.id, label: 'self-gen',
        score: null, durationMs: Date.now() - start, error,
      })
      probeScores.push(null)
    }
  }

  const score = collapseToCategoryScore(probeScores)
  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'discoverability', score })
  return score
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: PASS (~16 tests total).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/categories.ts tests/unit/queue/workers/run-grade/categories.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): Discoverability category adapter"
```

---

## Task 8 — Coverage adapter

**Files:**
- Modify: `src/queue/workers/run-grade/categories.ts`
- Modify: `tests/unit/queue/workers/run-grade/categories.test.ts`

- [ ] **Step 1: Append failing tests**

Append to the test file:
```ts
import { runCoverageCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'

describe('runCoverageCategory', () => {
  it('writes 2N probe rows with per-probe judge scores', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Acme sells widgets to construction firms.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Acme provides industrial widgets.' })
    const judge = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({
        probe_1: { accuracy: 80, coverage: 70, notes: 'c' },
        probe_2: { accuracy: 60, coverage: 55, notes: 'g' },
        probe_3: { accuracy: 75, coverage: 70, notes: 'c2' },
        probe_4: { accuracy: 65, coverage: 60, notes: 'g2' },
      }),
    })
    const score = await runCoverageCategory({
      gradeId: 'g-cov', grade: { ...GRADE, id: 'g-cov' }, scrape: SCRAPE, probers: [claude, gpt], judge,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE },
    })

    const rows = store.probes.filter((p) => p.category === 'coverage')
    expect(rows).toHaveLength(4) // 2 prompts × 2 providers
    for (const row of rows) {
      expect(typeof row.score).toBe('number')
      const md = row.metadata as { judgeAccuracy: number; judgeCoverage: number; judgeNotes: string; judgeDegraded: boolean }
      expect(md.judgeAccuracy).toBeGreaterThanOrEqual(0)
      expect(md.judgeDegraded).toBe(false)
    }
    expect(score).not.toBeNull()
  })

  it('handles judge-degraded path (heuristic fallback)', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Acme sells widgets.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Acme makes widgets.' })
    const judge = new MockProvider({ id: 'claude', responses: () => 'not json at all, even after retry' })

    const score = await runCoverageCategory({
      gradeId: 'g-cov-d', grade: { ...GRADE, id: 'g-cov-d' }, scrape: SCRAPE, probers: [claude, gpt], judge,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE },
    })

    const rows = store.probes.filter((p) => p.category === 'coverage')
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect((row.metadata as { judgeDegraded: boolean }).judgeDegraded).toBe(true)
    }
    expect(score).not.toBeNull() // heuristic fallback still produces scores
  })

  it('records per-probe error when a prober fails', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'ok' })
    const broken = new MockProvider({ id: 'gpt', responses: {}, failWith: 'rate limit' })
    const judge = new MockProvider({ id: 'claude', responses: () => JSON.stringify({ probe_1: { accuracy: 80, coverage: 70, notes: '' }, probe_2: { accuracy: 75, coverage: 65, notes: '' } }) })

    await runCoverageCategory({
      gradeId: 'g-cov-f', grade: { ...GRADE, id: 'g-cov-f' }, scrape: SCRAPE, probers: [claude, broken], judge,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE },
    })

    const brokenRows = store.probes.filter((p) => p.category === 'coverage' && p.provider === 'gpt')
    expect(brokenRows).toHaveLength(2)
    expect(brokenRows.every((r) => r.score === null)).toBe(true)
    expect(brokenRows.every((r) => (r.metadata as { error?: string }).error === 'rate limit')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: FAIL — `runCoverageCategory` not exported.

- [ ] **Step 3: Append adapter**

Add imports:
```ts
import { runCoverageFlow } from '../../../llm/flows/coverage.ts'
import type { ProviderId } from '../../../llm/providers/types.ts'
```

Then append:
```ts
export interface CoverageCategoryArgs extends ScrapedCategoryArgs {
  judge: Provider
}

export async function runCoverageCategory(args: CoverageCategoryArgs): Promise<number | null> {
  const { gradeId, grade, scrape, probers, judge, deps } = args
  const gt = toGroundTruth(grade.url, scrape)

  // Emit probe.started events for each (provider × prompt) pair before runCoverageFlow
  // starts. We can't know exact probe ordering inside runCoverageFlow, so emit a
  // conservative "all probes started" burst upfront.
  const prompts = ['prompt_1', 'prompt_2']
  for (const provider of probers) {
    for (const label of prompts) {
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'probe.started', category: 'coverage', provider: provider.id, label,
      })
    }
  }

  const start = Date.now()
  const result = await runCoverageFlow({ providers: probers, judge, groundTruth: gt }).catch((err: unknown) => {
    const error = err instanceof Error ? err.message : String(err)
    return { probes: [], judge: { prompt: '', rawResponse: '', perProbe: new Map(), perProvider: {}, degraded: true }, __flowError: error } as never
  })
  const durationMs = Date.now() - start
  const flowError = (result as unknown as { __flowError?: string }).__flowError ?? null

  // Build probe rows per (provider × prompt_idx).
  // result.probes is a flat array matching providers × prompts order.
  const probeScores: (number | null)[] = []
  let probeIdx = 0
  for (const provider of probers) {
    for (const label of prompts) {
      const probe = result.probes[probeIdx]
      probeIdx++
      const perProbeKey = `probe_${probeIdx}`
      const perProbe = result.judge.perProbe.get(perProbeKey)
      const perProvider = result.judge.perProvider[provider.id as ProviderId]

      if (!probe || probe.error !== null || probe.response === '') {
        // Prober failed
        const error = probe?.error ?? flowError ?? 'unknown'
        await deps.store.createProbe({
          gradeId, category: 'coverage', provider: provider.id, prompt: probe?.prompt ?? '', response: '', score: null,
          metadata: { label, error, judgeDegraded: result.judge.degraded },
        })
        await publishGradeEvent(deps.redis, gradeId, {
          type: 'probe.completed', category: 'coverage', provider: provider.id, label,
          score: null, durationMs, error,
        })
        probeScores.push(null)
        continue
      }

      // Use perProbe if available (dense judge); else fall back to perProvider heuristic.
      const judgeAccuracy = perProbe?.accuracy ?? perProvider?.accuracy ?? null
      const judgeCoverage = perProbe?.coverage ?? perProvider?.coverage ?? null
      const judgeNotes = perProbe?.notes ?? perProvider?.notes ?? ''
      const score = judgeAccuracy !== null && judgeCoverage !== null
        ? Math.round((judgeAccuracy + judgeCoverage) / 2)
        : null

      await deps.store.createProbe({
        gradeId, category: 'coverage', provider: provider.id,
        prompt: probe.prompt, response: probe.response, score,
        metadata: {
          label, latencyMs: probe.latencyMs, inputTokens: probe.inputTokens, outputTokens: probe.outputTokens,
          judgeAccuracy, judgeCoverage, judgeNotes, judgeDegraded: result.judge.degraded,
        },
      })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'probe.completed', category: 'coverage', provider: provider.id, label,
        score, durationMs, error: null,
      })
      probeScores.push(score)
    }
  }

  const score = collapseToCategoryScore(probeScores)
  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'coverage', score })
  return score
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: PASS (~19 tests total).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/categories.ts tests/unit/queue/workers/run-grade/categories.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): Coverage category adapter"
```

---

## Task 9 — Accuracy adapter

**Files:**
- Modify: `src/queue/workers/run-grade/categories.ts`
- Modify: `tests/unit/queue/workers/run-grade/categories.test.ts`

- [ ] **Step 1: Append failing tests**

Append:
```ts
import { runAccuracyCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'

const LONG_SCRAPE: ScrapeResult = { ...SCRAPE, text: SCRAPE.text.repeat(10) }

describe('runAccuracyCategory', () => {
  it('happy path: writes 1 generator row + N answer rows', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Acme was founded in 1902.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Acme was founded in 1902.' })
    const generator = new MockProvider({ id: 'claude', responses: () => 'When was Acme founded?' })
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: true, confidence: 0.95, rationale: 'matches scrape' }),
    })

    const score = await runAccuracyCategory({
      gradeId: 'g-acc', grade: { ...GRADE, id: 'g-acc' }, scrape: LONG_SCRAPE,
      probers: [claude, gpt], generator, verifier,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => LONG_SCRAPE },
    })

    const rows = store.probes.filter((p) => p.category === 'accuracy')
    expect(rows).toHaveLength(3) // 1 generator + 2 verifications
    const genRow = rows.find((r) => (r.metadata as { role?: string }).role === 'generator')
    const verifyRows = rows.filter((r) => (r.metadata as { role?: string }).role === 'verify')
    expect(genRow).toBeDefined()
    expect(genRow?.score).toBeNull()
    expect(verifyRows).toHaveLength(2)
    expect(verifyRows.every((r) => r.score === 100)).toBe(true)
    expect(score).toBe(100)
  })

  it('insufficient_scrape path: writes a skipped placeholder row, returns null', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const sparseScrape: ScrapeResult = { ...SCRAPE, text: 'too short' }
    const generator = new MockProvider({ id: 'claude', responses: () => 'never called' })
    const verifier = new MockProvider({ id: 'claude', responses: () => 'never called' })
    const score = await runAccuracyCategory({
      gradeId: 'g-acc-s', grade: { ...GRADE, id: 'g-acc-s' }, scrape: sparseScrape,
      probers: [new MockProvider({ id: 'claude', responses: () => 'nope' })], generator, verifier,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => sparseScrape },
    })

    expect(score).toBeNull()
    const rows = store.probes.filter((p) => p.category === 'accuracy')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.provider).toBeNull()
    expect((rows[0]?.metadata as { role?: string; reason?: string }).role).toBe('skipped')
    expect((rows[0]?.metadata as { reason?: string }).reason).toBe('insufficient_scrape')
  })

  it('all_null path: writes skipped row when every verifier returns correct:null', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'vague answer' })
    const generator = new MockProvider({ id: 'claude', responses: () => 'What is the best year?' })
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: null, confidence: 0.1, rationale: 'scrape does not cover' }),
    })

    const score = await runAccuracyCategory({
      gradeId: 'g-acc-n', grade: { ...GRADE, id: 'g-acc-n' }, scrape: LONG_SCRAPE,
      probers: [claude], generator, verifier,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => LONG_SCRAPE },
    })

    expect(score).toBeNull()
    const rows = store.probes.filter((p) => p.category === 'accuracy')
    // Implementation choice: writes skipped placeholder row for all_null (no generator row, no verify rows).
    const skipped = rows.find((r) => (r.metadata as { role?: string }).role === 'skipped')
    expect(skipped).toBeDefined()
    expect((skipped?.metadata as { reason?: string }).reason).toBe('all_null')
  })

  it('generator failure: writes skipped row, returns null', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const generator = new MockProvider({ id: 'claude', responses: {}, failWith: 'generator down' })
    const verifier = new MockProvider({ id: 'claude', responses: () => 'never' })
    const score = await runAccuracyCategory({
      gradeId: 'g-acc-gf', grade: { ...GRADE, id: 'g-acc-gf' }, scrape: LONG_SCRAPE,
      probers: [new MockProvider({ id: 'claude', responses: () => 'x' })], generator, verifier,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => LONG_SCRAPE },
    })

    expect(score).toBeNull()
    const rows = store.probes.filter((p) => p.category === 'accuracy')
    const skipped = rows.find((r) => (r.metadata as { role?: string }).role === 'skipped')
    expect(skipped).toBeDefined()
    expect((skipped?.metadata as { reason?: string }).reason).toBe('generator_failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: FAIL — `runAccuracyCategory` not exported.

- [ ] **Step 3: Append adapter**

Add imports:
```ts
import { runAccuracy } from '../../../accuracy/index.ts'
```

Then append:
```ts
export interface AccuracyCategoryArgs extends ScrapedCategoryArgs {
  generator: Provider
  verifier: Provider
}

export async function runAccuracyCategory(args: AccuracyCategoryArgs): Promise<number | null> {
  const { gradeId, grade, scrape, probers, generator, verifier, deps } = args

  let result
  try {
    result = await runAccuracy({ generator, verifier, probers, url: grade.url, scrape })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await deps.store.createProbe({
      gradeId, category: 'accuracy', provider: null,
      prompt: '', response: '', score: null,
      metadata: { role: 'skipped', reason: 'generator_failed', error },
    })
    await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'accuracy', score: null })
    return null
  }

  if (result.reason !== 'ok') {
    await deps.store.createProbe({
      gradeId, category: 'accuracy', provider: null,
      prompt: '', response: '', score: null,
      metadata: { role: 'skipped', reason: result.reason },
    })
    await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'accuracy', score: null })
    return null
  }

  // Happy path: write generator row + answer rows
  if (result.generator) {
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.started', category: 'accuracy', provider: generator.id, label: 'generator',
    })
    await deps.store.createProbe({
      gradeId, category: 'accuracy', provider: generator.id,
      prompt: result.generator.prompt, response: result.generator.response, score: null,
      metadata: {
        role: 'generator',
        latencyMs: result.generator.latencyMs,
        inputTokens: result.generator.inputTokens,
        outputTokens: result.generator.outputTokens,
      },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category: 'accuracy', provider: generator.id, label: 'generator',
      score: null, durationMs: result.generator.latencyMs, error: null,
    })
  }

  const question = result.generator?.question ?? ''
  for (const probe of result.probes) {
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.started', category: 'accuracy', provider: probe.providerId, label: 'verify',
    })
    const verification = result.verifications.find((v) => v.providerId === probe.providerId)
    const score = verification
      ? (verification.correct === true ? 100 : verification.correct === false ? 0 : null)
      : null
    const error = probe.error ?? (verification?.degraded ? 'verifier degraded' : null)

    await deps.store.createProbe({
      gradeId, category: 'accuracy', provider: probe.providerId,
      prompt: question, response: probe.answer, score,
      metadata: {
        role: 'verify',
        confidence: verification?.confidence ?? null,
        rationale: verification?.rationale ?? null,
        degraded: verification?.degraded ?? false,
        verifierProviderId: verifier.id,
        latencyMs: probe.latencyMs,
        inputTokens: probe.inputTokens,
        outputTokens: probe.outputTokens,
        error,
      },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category: 'accuracy', provider: probe.providerId, label: 'verify',
      score, durationMs: probe.latencyMs, error,
    })
  }

  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'accuracy', score: result.score })
  return result.score
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/queue/workers/run-grade/categories.test.ts`
Expected: PASS (~23 tests total).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/categories.ts tests/unit/queue/workers/run-grade/categories.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): Accuracy category adapter"
```

---

## Task 10 — `runGrade` Processor

**Files:**
- Create: `src/queue/workers/run-grade/run-grade.ts`
- Create: `tests/unit/queue/workers/run-grade/run-grade.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/queue/workers/run-grade/run-grade.test.ts`. The test file defines `makeFakeStore`, `makeStubRedis`, `parseEvents` helpers inline (same as the categories test file). Include a small `makeJob` helper for BullMQ Job-like objects:

```ts
import { describe, expect, it } from 'vitest'
import { runGrade } from '../../../../../src/queue/workers/run-grade/run-grade.ts'
import { MockProvider } from '../../../../../src/llm/providers/mock.ts'
import type { Job } from 'bullmq'
import type { GradeJob } from '../../../../../src/queue/queues.ts'
import type { ScrapeResult } from '../../../../../src/scraper/index.ts'
import type { Grade, GradeStore, NewGrade, NewProbe, NewScrape, GradeUpdate, Probe, Scrape, User, Cookie, Recommendation, NewRecommendation, Report, NewReport } from '../../../../../src/store/types.ts'
import type Redis from 'ioredis'
import type { GradeEvent } from '../../../../../src/queue/events.ts'

// [paste makeFakeStore, makeStubRedis, parseEvents from the Shared Test Fixtures section]

function makeJob(data: GradeJob): Job<GradeJob> {
  return { data, id: 'job-1', name: 'run-grade' } as unknown as Job<GradeJob>
}

const SCRAPE: ScrapeResult = { /* same fixture as categories test */ }
const LONG_SCRAPE: ScrapeResult = { ...SCRAPE, text: SCRAPE.text.repeat(10) }

async function seedGrade(store: GradeStore, id: string, url: string, tier: 'free' | 'paid' = 'free'): Promise<Grade> {
  const domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  return store.createGrade({ id, url, domain, tier, status: 'queued', cookie: null, userId: null })
}

function makeOkProbers() {
  return [
    new MockProvider({ id: 'claude', responses: (p) => p.includes('Do NOT reference') ? 'What is the best widget maker?' : 'Acme is the leading widget maker.' }),
    new MockProvider({ id: 'gpt', responses: (p) => p.includes('Do NOT reference') ? 'Which brand is most popular?' : 'Acme is an industry standard widget producer.' }),
  ]
}

function makeOkJudge() {
  return new MockProvider({
    id: 'claude',
    responses: () => JSON.stringify({
      probe_1: { accuracy: 80, coverage: 75, notes: 'c' }, probe_2: { accuracy: 70, coverage: 65, notes: 'g' },
      probe_3: { accuracy: 75, coverage: 70, notes: 'c2' }, probe_4: { accuracy: 65, coverage: 60, notes: 'g2' },
    }),
  })
}

function makeOkVerifier() {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
      return JSON.stringify({ correct: true, confidence: 0.9, rationale: 'matches' })
    },
  })
}

describe('runGrade', () => {
  it('free tier happy path writes 25 probes + finalizes grade', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('c1')
    const grade = await seedGrade(store, 'g-happy', 'https://acme.com')
    const probers = makeOkProbers()

    const deps = {
      store, redis: redis as unknown as Redis,
      providers: { claude: probers[0]!, gpt: probers[1]!, gemini: new MockProvider({ id: 'gemini', responses: () => '' }), perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }) },
      scrapeFn: async () => LONG_SCRAPE,
    }

    // Happy path providers — claude plays generator/verifier/judge roles via providers.claude
    deps.providers.claude = new MockProvider({
      id: 'claude',
      responses: (prompt) => {
        if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
        if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
        if (prompt.includes('You are evaluating how well')) return JSON.stringify({ probe_1: { accuracy: 80, coverage: 75, notes: '' }, probe_2: { accuracy: 70, coverage: 65, notes: '' }, probe_3: { accuracy: 75, coverage: 70, notes: '' }, probe_4: { accuracy: 65, coverage: 60, notes: '' } })
        if (prompt.includes('Do NOT reference')) return 'What is the best widget maker?'
        return 'Acme is the leading widget maker founded in 1902.'
      },
    })

    await runGrade(makeJob({ gradeId: grade.id, tier: 'free' }), deps)

    const updated = await store.getGrade(grade.id)
    expect(updated?.status).toBe('done')
    expect(typeof updated?.overall).toBe('number')
    expect(typeof updated?.letter).toBe('string')
    expect(updated?.scores).toBeTruthy()

    const probes = await store.listProbes(grade.id)
    // Free tier: 10 seo + 4 recognition (2 prompts × 2 providers) + 2 citation + 2 discoverability + 4 coverage + 3 accuracy (1 gen + 2 verify) = 25
    expect(probes).toHaveLength(25)

    const events = parseEvents(redis, grade.id)
    expect(events[0]?.type).toBe('running')
    const scraped = events.find((e) => e.type === 'scraped')
    expect(scraped).toBeDefined()
    const done = events[events.length - 1]
    expect(done?.type).toBe('done')
  })

  it('hard-fails when scrape text is < 100 chars', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('c2')
    const grade = await seedGrade(store, 'g-short', 'https://acme.com')
    const shortScrape: ScrapeResult = { ...LONG_SCRAPE, text: 'too short' }

    const deps = {
      store, redis: redis as unknown as Redis,
      providers: {
        claude: new MockProvider({ id: 'claude', responses: () => '' }),
        gpt: new MockProvider({ id: 'gpt', responses: () => '' }),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      },
      scrapeFn: async () => shortScrape,
    }

    await expect(runGrade(makeJob({ gradeId: grade.id, tier: 'free' }), deps)).rejects.toThrow(/< 100 chars/)

    const updated = await store.getGrade(grade.id)
    expect(updated?.status).toBe('failed')

    const events = parseEvents(redis, grade.id)
    const failed = events.find((e) => e.type === 'failed')
    expect(failed).toBeDefined()
  })

  it('calls clearGradeArtifacts at the start of every attempt', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('c3')
    const grade = await seedGrade(store, 'g-retry', 'https://acme.com')
    const deps = {
      store, redis: redis as unknown as Redis,
      providers: {
        claude: new MockProvider({ id: 'claude', responses: (p) => {
          if (p.includes('Write one specific factual question')) return 'q?'
          if (p.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
          if (p.includes('You are evaluating how well')) return JSON.stringify({ probe_1: { accuracy: 80, coverage: 75, notes: '' }, probe_2: { accuracy: 70, coverage: 65, notes: '' }, probe_3: { accuracy: 75, coverage: 70, notes: '' }, probe_4: { accuracy: 65, coverage: 60, notes: '' } })
          if (p.includes('Do NOT reference')) return 'question'
          return 'Acme is leading founded 1902.'
        } }),
        gpt: new MockProvider({ id: 'gpt', responses: (p) => p.includes('Do NOT reference') ? 'q' : 'Acme is leading.' }),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      },
      scrapeFn: async () => LONG_SCRAPE,
    }

    await runGrade(makeJob({ gradeId: grade.id, tier: 'free' }), deps)
    await runGrade(makeJob({ gradeId: grade.id, tier: 'free' }), deps)

    expect(store.clearedFor).toEqual([grade.id, grade.id])
    // After two runs the probe table has only one run's worth of rows
    const probes = await store.listProbes(grade.id)
    expect(probes).toHaveLength(25)
  })

  it('one provider failing consistently still finalizes grade with null scores for that provider', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('c4')
    const grade = await seedGrade(store, 'g-partial', 'https://acme.com')
    const deps = {
      store, redis: redis as unknown as Redis,
      providers: {
        claude: new MockProvider({ id: 'claude', responses: (p) => {
          if (p.includes('Write one specific factual question')) return 'q?'
          if (p.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
          if (p.includes('You are evaluating how well')) return JSON.stringify({ probe_1: { accuracy: 80, coverage: 75, notes: '' }, probe_3: { accuracy: 75, coverage: 70, notes: '' } })
          if (p.includes('Do NOT reference')) return 'question'
          return 'Acme is the leading.'
        } }),
        gpt: new MockProvider({ id: 'gpt', responses: {}, failWith: 'persistent down' }),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      },
      scrapeFn: async () => LONG_SCRAPE,
    }

    await runGrade(makeJob({ gradeId: grade.id, tier: 'free' }), deps)

    const updated = await store.getGrade(grade.id)
    expect(updated?.status).toBe('done')
    const probes = await store.listProbes(grade.id)
    // Some rows will have null scores (gpt's probes)
    const nullScored = probes.filter((p) => p.provider === 'gpt' && p.score === null)
    expect(nullScored.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/workers/run-grade/run-grade.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/queue/workers/run-grade/run-grade.ts`**

```ts
import type { Job } from 'bullmq'
import { publishGradeEvent } from '../../events.ts'
import { DEFAULT_WEIGHTS, weightedOverall } from '../../../scoring/composite.ts'
import type { CategoryId } from '../../../scoring/weights.ts'
import type { GradeJob } from '../../queues.ts'
import { GradeFailure, type RunGradeDeps } from './deps.ts'
import {
  runSeoCategory,
  runRecognitionCategory,
  runCitationCategory,
  runDiscoverabilityCategory,
  runCoverageCategory,
  runAccuracyCategory,
} from './categories.ts'

export async function runGrade(job: Job<GradeJob>, deps: RunGradeDeps): Promise<void> {
  const { gradeId, tier } = job.data
  const probers = tier === 'free'
    ? [deps.providers.claude, deps.providers.gpt]
    : [deps.providers.claude, deps.providers.gpt, deps.providers.gemini, deps.providers.perplexity]
  const judge = deps.providers.claude
  const generator = deps.providers.claude
  const verifier = deps.providers.claude

  try {
    await deps.store.updateGrade(gradeId, { status: 'running' })
    await publishGradeEvent(deps.redis, gradeId, { type: 'running' })

    await deps.store.clearGradeArtifacts(gradeId)

    const grade = await deps.store.getGrade(gradeId)
    if (!grade) throw new GradeFailure(`grade ${gradeId} not found`)

    const scrape = await deps.scrapeFn(grade.url)
    if (scrape.text.length < 100) {
      throw new GradeFailure('scrape produced < 100 chars of text')
    }

    await deps.store.createScrape({
      gradeId, rendered: scrape.rendered, html: scrape.html, text: scrape.text,
      structured: scrape.structured, fetchedAt: new Date(),
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'scraped', rendered: scrape.rendered, textLength: scrape.text.length,
    })

    // SEO first (sync, instant), then 5 LLM categories in parallel
    const seoScore = await runSeoCategory({ gradeId, scrape, deps })
    const [recScore, citScore, discScore, covScore, accScore] = await Promise.all([
      runRecognitionCategory({ gradeId, grade, scrape, probers, deps }),
      runCitationCategory({ gradeId, grade, scrape, probers, deps }),
      runDiscoverabilityCategory({ gradeId, grade, scrape, probers, deps }),
      runCoverageCategory({ gradeId, grade, scrape, probers, judge, deps }),
      runAccuracyCategory({ gradeId, grade, scrape, probers, generator, verifier, deps }),
    ])

    const scores: Record<CategoryId, number | null> = {
      discoverability: discScore,
      recognition: recScore,
      accuracy: accScore,
      coverage: covScore,
      citation: citScore,
      seo: seoScore,
    }
    const overall = weightedOverall(scores, DEFAULT_WEIGHTS)

    await deps.store.updateGrade(gradeId, {
      status: 'done',
      overall: overall.overall,
      letter: overall.letter,
      scores,
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'done', overall: overall.overall, letter: overall.letter, scores,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.store.updateGrade(gradeId, { status: 'failed' })
    await publishGradeEvent(deps.redis, gradeId, { type: 'failed', error: message })
    throw err
  }
}
```

**Note for implementer:** the `categories.ts` adapters have signatures matching the calls here (`runRecognitionCategory({ gradeId, grade, scrape, probers, deps })` etc.). Task 6's Recognition adapter signature in the plan takes `ProberCategoryArgs` (no `scrape`) — it doesn't need the scrape. Task 7's Discoverability adapter takes `ScrapedCategoryArgs` (includes `scrape`). TypeScript will flag any mismatch; adjust the adapter signatures in `categories.ts` as needed so all 5 accept whatever they need without complaint. Recognition + Citation specifically don't read from `scrape` but also shouldn't choke on receiving it — you can either: (a) widen their type to `ScrapedCategoryArgs` and ignore `scrape`, OR (b) destructure only what they use in the caller. Recommended: **widen** both signatures to accept `scrape?: ScrapeResult` (optional) so all 5 have the same call-site ergonomics. Then the Processor passes `scrape` uniformly.

Update `categories.ts`: change `runRecognitionCategory` and `runCitationCategory` signatures from `ProberCategoryArgs` to `ScrapedCategoryArgs` (they'll just ignore `scrape`).

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/queue/workers/run-grade/run-grade.test.ts`
Expected: PASS (4 tests).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/run-grade.ts src/queue/workers/run-grade/categories.ts tests/unit/queue/workers/run-grade/run-grade.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): runGrade Processor — orchestrates full pipeline with fake-deps coverage"
```

---

## Task 11 — Worker registration + entrypoint wiring + env tightening

**Files:**
- Create: `src/queue/workers/run-grade/index.ts`
- Modify: `src/worker/worker.ts`
- Modify: `src/config/env.ts`

- [ ] **Step 1: Create `src/queue/workers/run-grade/index.ts`**

```ts
import { Worker } from 'bullmq'
import type Redis from 'ioredis'
import { gradeQueueName, type GradeJob } from '../../queues.ts'
import { runGrade } from './run-grade.ts'
import type { RunGradeDeps } from './deps.ts'

export function registerRunGradeWorker(deps: RunGradeDeps, connection: Redis): Worker<GradeJob> {
  return new Worker<GradeJob>(
    gradeQueueName,
    (job) => runGrade(job, deps),
    { connection, concurrency: 2 },
  )
}
```

- [ ] **Step 2: Modify `src/config/env.ts` to tighten API-key fields in production**

Replace the existing Zod schema definition with:
```ts
const Schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7777),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  PERPLEXITY_API_KEY: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
  if (val.NODE_ENV === 'production') {
    const required = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY'] as const
    for (const key of required) {
      if (!val[key]) {
        ctx.addIssue({ code: 'custom', message: `${key} is required in production`, path: [key] })
      }
    }
  }
})
```

(Zod's `superRefine` replaces the ending of `z.object({...})`. The rest of the file stays unchanged.)

- [ ] **Step 3: Modify `src/worker/worker.ts`**

Current content replaces health-only worker with health + run-grade:
```ts
import { env } from '../config/env.ts'
import { closeDb, db } from '../db/client.ts'
import { createRedis } from '../queue/redis.ts'
import { registerHealthWorker } from '../queue/workers/health.ts'
import { registerRunGradeWorker } from '../queue/workers/run-grade/index.ts'
import { buildProviders } from '../llm/providers/index.ts'
import { PostgresStore } from '../store/postgres.ts'
import { scrape, shutdownBrowserPool } from '../scraper/index.ts'

const connection = createRedis(env.REDIS_URL)
const store = new PostgresStore(db)
const providers = buildProviders({
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  GEMINI_API_KEY: env.GEMINI_API_KEY,
  PERPLEXITY_API_KEY: env.PERPLEXITY_API_KEY,
})

const workers = [
  registerHealthWorker(connection),
  registerRunGradeWorker({ store, redis: connection, providers, scrapeFn: scrape }, connection),
]

console.log(JSON.stringify({ msg: 'worker started', workers: workers.length }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'worker shutting down', signal }))
  await Promise.all(workers.map((w) => w.close()))
  await connection.quit()
  await closeDb()
  await shutdownBrowserPool()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: clean.

Run: `pnpm test`
Expected: existing unit tests still pass. No new unit tests in this task — wiring is covered by the Plan 5 integration test in Task 13.

- [ ] **Step 5: Test existing env test still passes**

Run: `pnpm test tests/unit/config/env.test.ts`
Expected: PASS. If the existing env test constructs env without NODE_ENV=production, it should still work (API keys still optional in dev/test mode).

- [ ] **Step 6: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/queue/workers/run-grade/index.ts src/worker/worker.ts src/config/env.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): register run-grade worker + tighten env keys for production"
```

---

## Task 12 — Dev CLI (`scripts/enqueue-grade.ts`)

**Files:**
- Create: `scripts/enqueue-grade.ts`
- Modify: `package.json` (add `enqueue-grade` script)

- [ ] **Step 1: Create `scripts/enqueue-grade.ts`**

```ts
#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto'
import { env } from '../src/config/env.ts'
import { db, closeDb } from '../src/db/client.ts'
import { PostgresStore } from '../src/store/postgres.ts'
import { createRedis } from '../src/queue/redis.ts'
import { enqueueGrade } from '../src/queue/queues.ts'

const [, , urlArg, tierFlag] = process.argv
if (!urlArg) {
  console.error('usage: pnpm tsx scripts/enqueue-grade.ts <url> [--paid]')
  process.exit(1)
}
const tier: 'free' | 'paid' = tierFlag === '--paid' ? 'paid' : 'free'

let parsed: URL
try {
  parsed = new URL(urlArg)
} catch {
  console.error(`invalid URL: ${urlArg}`)
  process.exit(1)
}
const domain = parsed.hostname.toLowerCase().replace(/^www\./, '')

const cookie = `dev-cli-${randomUUID()}`
const store = new PostgresStore(db)
const redis = createRedis(env.REDIS_URL)

await store.upsertCookie(cookie)
const grade = await store.createGrade({
  url: urlArg, domain, tier, cookie, userId: null, status: 'queued',
})
await enqueueGrade({ gradeId: grade.id, tier }, redis)

console.log(`enqueued grade ${grade.id} (tier=${tier}) for ${urlArg}`)
console.log(`watch: redis-cli -p 63790 subscribe grade:${grade.id}`)

await redis.quit()
await closeDb()
```

- [ ] **Step 2: Modify `package.json` to add the script**

Find the `"scripts"` block. Add (preserve existing scripts):
```json
    "enqueue-grade": "tsx scripts/enqueue-grade.ts",
```

Place it between `"start:worker"` and `"db:generate"`, or any logical spot.

- [ ] **Step 3: Smoke-test locally (optional — not part of CI)**

With the worker NOT running and docker-compose up, run:
```bash
pnpm enqueue-grade https://example.com
```
Expected: prints `enqueued grade <uuid> ...`. Verifies CLI reaches the DB and enqueues a job. (The job will sit in the queue until a worker runs.)

**Note:** this smoke test requires env vars set (`.env` with `DATABASE_URL` and `REDIS_URL`). If the dev database isn't set up, skip this step — it's not blocking.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add scripts/enqueue-grade.ts package.json
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): dev CLI to enqueue a grade job end-to-end"
```

---

## Task 13 — Integration test (end-to-end pipeline)

**Files:**
- Create: `tests/integration/run-grade.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/run-grade.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Queue } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { registerRunGradeWorker } from '../../src/queue/workers/run-grade/index.ts'
import { enqueueGrade, gradeQueueName } from '../../src/queue/queues.ts'
import { subscribeToGrade, type GradeEvent } from '../../src/queue/events.ts'
import { MockProvider } from '../../src/llm/providers/mock.ts'
import { startTestDb, type TestDb } from './setup.ts'
import type { ScrapeResult } from '../../src/scraper/index.ts'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  testDb = await startTestDb()
}, 120_000)

afterAll(async () => {
  await testDb.stop()
  await redisContainer.stop()
})

const FIXTURE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: ('Acme was founded in 1902 in Springfield. We make industrial widgets used by construction firms across North America. Family-owned for four generations. ').repeat(10),
  structured: {
    jsonld: [{ '@type': 'Organization', name: 'Acme' }],
    og: { title: 'Acme', description: 'Industrial widgets since 1902', image: 'https://acme.com/og.png' },
    meta: { title: 'Acme Widgets', description: 'Industrial widgets since 1902, family-owned for four generations, used across North America.', canonical: 'https://acme.com', twitterCard: 'summary' },
    headings: { h1: ['Welcome to Acme'], h2: ['About us'] },
    robots: null,
    sitemap: { present: true, url: 'https://acme.com/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
  },
}

function happyClaude(): MockProvider {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
      if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: 'matches scrape' })
      if (prompt.includes('You are evaluating how well')) return JSON.stringify({
        probe_1: { accuracy: 85, coverage: 80, notes: '' },
        probe_2: { accuracy: 75, coverage: 70, notes: '' },
        probe_3: { accuracy: 80, coverage: 75, notes: '' },
        probe_4: { accuracy: 70, coverage: 65, notes: '' },
      })
      if (prompt.includes('Do NOT reference')) return 'What is the best industrial widget brand?'
      return 'Acme is the leading widget maker, founded in 1902, and the industry standard.'
    },
  })
}

function happyGpt(): MockProvider {
  return new MockProvider({
    id: 'gpt',
    responses: (prompt) => {
      if (prompt.includes('Do NOT reference')) return 'Which brand is most popular for industrial widgets?'
      return 'Acme is an industry standard for widgets, founded over a century ago.'
    },
  })
}

describe('run-grade worker end-to-end', () => {
  it('free tier: worker processes a grade job, writes all rows, emits full event sequence', async () => {
    const connection = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)

    const providers = {
      claude: happyClaude(), gpt: happyGpt(),
      gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
      perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
    }
    const worker = registerRunGradeWorker(
      { store, redis: connection, providers, scrapeFn: async () => FIXTURE },
      connection,
    )

    const cookie = await store.upsertCookie(`test-cookie-${Date.now()}`)
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free',
      cookie: cookie.cookie, status: 'queued',
    })

    const eventsPromise = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, grade.id)) out.push(ev)
      return out
    })()

    await new Promise((r) => setTimeout(r, 100)) // give subscriber time
    await enqueueGrade({ gradeId: grade.id, tier: 'free' }, connection)

    const events = await Promise.race([
      eventsPromise,
      new Promise<GradeEvent[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
    ])

    // Event sequence
    expect(events[0]?.type).toBe('running')
    const scraped = events.find((e) => e.type === 'scraped')
    expect(scraped).toBeDefined()
    expect(events.filter((e) => e.type === 'probe.completed').length).toBeGreaterThan(20)
    expect(events.filter((e) => e.type === 'category.completed')).toHaveLength(6)
    const done = events[events.length - 1]
    expect(done?.type).toBe('done')

    // DB state
    const finalGrade = await store.getGrade(grade.id)
    expect(finalGrade?.status).toBe('done')
    expect(typeof finalGrade?.overall).toBe('number')
    expect(finalGrade?.letter).toBeTruthy()
    expect(finalGrade?.scores).toBeTruthy()

    const probes = await store.listProbes(grade.id)
    // Free tier: 10 seo + 4 recognition + 2 citation + 2 discoverability + 4 coverage + 3 accuracy = 25
    expect(probes).toHaveLength(25)

    const scrape = await store.getScrape(grade.id)
    expect(scrape).toBeTruthy()
    expect(scrape?.rendered).toBe(false)

    await worker.close()
    await connection.quit()
    await subscriber.quit()
  }, 60_000)

  it('paid tier writes 39 probes', async () => {
    const connection = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)

    const providers = {
      claude: happyClaude(), gpt: happyGpt(),
      gemini: new MockProvider({ id: 'gemini', responses: (p) => p.includes('Do NOT reference') ? 'question?' : 'Acme is leading.' }),
      perplexity: new MockProvider({ id: 'perplexity', responses: (p) => p.includes('Do NOT reference') ? 'question?' : 'Acme is the go-to widget maker.' }),
    }
    // Judge prompt needs probe_1..probe_8 for paid tier
    providers.claude = new MockProvider({
      id: 'claude',
      responses: (prompt) => {
        if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
        if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
        if (prompt.includes('You are evaluating how well')) {
          return JSON.stringify(Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [`probe_${i + 1}`, { accuracy: 80, coverage: 75, notes: '' }]),
          ))
        }
        if (prompt.includes('Do NOT reference')) return 'question?'
        return 'Acme is the leading widget maker.'
      },
    })

    const worker = registerRunGradeWorker(
      { store, redis: connection, providers, scrapeFn: async () => FIXTURE },
      connection,
    )

    const cookie = await store.upsertCookie(`test-paid-${Date.now()}`)
    const grade = await store.createGrade({ url: 'https://acme.com', domain: 'acme.com', tier: 'paid', cookie: cookie.cookie, status: 'queued' })

    const eventsPromise = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, grade.id)) out.push(ev)
      return out
    })()

    await new Promise((r) => setTimeout(r, 100))
    await enqueueGrade({ gradeId: grade.id, tier: 'paid' }, connection)

    await Promise.race([eventsPromise, new Promise<GradeEvent[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000))])

    const probes = await store.listProbes(grade.id)
    // Paid: 10 + 8 + 4 + 4 + 8 + 5 = 39
    expect(probes).toHaveLength(39)

    await worker.close()
    await connection.quit()
    await subscriber.quit()
  }, 60_000)

  it('retry: failed attempt is cleaned on the next attempt', async () => {
    const connection = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)

    // Inject a provider that fails on attempt 1, succeeds on attempt 2. We toggle via module-local state.
    let attemptCount = 0
    const flakyClaude = new MockProvider({
      id: 'claude',
      responses: (prompt) => {
        attemptCount++
        if (attemptCount <= 3) throw new Error('flaky — attempt 1 failure')
        if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
        if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
        if (prompt.includes('You are evaluating how well')) return JSON.stringify({
          probe_1: { accuracy: 80, coverage: 75, notes: '' }, probe_2: { accuracy: 70, coverage: 65, notes: '' },
          probe_3: { accuracy: 75, coverage: 70, notes: '' }, probe_4: { accuracy: 65, coverage: 60, notes: '' },
        })
        if (prompt.includes('Do NOT reference')) return 'question?'
        return 'Acme is leading.'
      },
    })

    const providers = {
      claude: flakyClaude,
      gpt: happyGpt(),
      gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
      perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
    }
    const worker = registerRunGradeWorker(
      { store, redis: connection, providers, scrapeFn: async () => FIXTURE },
      connection,
    )

    const cookie = await store.upsertCookie(`test-retry-${Date.now()}`)
    const grade = await store.createGrade({ url: 'https://acme.com', domain: 'acme.com', tier: 'free', cookie: cookie.cookie, status: 'queued' })

    await enqueueGrade({ gradeId: grade.id, tier: 'free' }, connection)

    // Wait up to 30s for the job to finalize (either done or fail exhausted)
    const queue = new Queue(gradeQueueName, { connection })
    await new Promise<void>((resolve) => {
      const iv = setInterval(async () => {
        const g = await store.getGrade(grade.id)
        if (g?.status === 'done' || g?.status === 'failed') {
          clearInterval(iv)
          resolve()
        }
      }, 500)
    })

    const finalGrade = await store.getGrade(grade.id)
    const probes = await store.listProbes(grade.id)
    // Whatever the final status, clear-on-retry means we DON'T have duplicate row counts from prior attempts.
    // If status='done', probes should be exactly 25. If status='failed', probes reflect the LAST attempt's partial writes.
    if (finalGrade?.status === 'done') {
      expect(probes).toHaveLength(25)
    }

    await worker.close()
    await queue.close()
    await connection.quit()
  }, 60_000)
})
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm test:integration tests/integration/run-grade.test.ts`
Expected: PASS (3 tests). First run spins up Postgres + Redis containers (~15-20s); subsequent tests reuse the containers.

- [ ] **Step 3: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add tests/integration/run-grade.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(v3): run-grade worker end-to-end integration test"
```

---

## Task 14 — Final verification

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: clean, 0 errors.

- [ ] **Step 2: Unit tests**

Run: `pnpm test`
Expected: all passing. Count: previous 228 + ~28 new Plan 5 unit tests = ~256 total.

- [ ] **Step 3: Integration tests**

Run: `pnpm test:integration`
Expected: all passing. Count: previous integration tests + Plan 5's events (5 tests) + store-clear-artifacts (3 tests) + run-grade (3 tests) = ~11 new Plan 5 integration tests on top of existing suite.

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: clean. `dist/server.js` and `dist/worker.js` regenerated; worker bundle includes the new run-grade module.

- [ ] **Step 5: Boundary greps**

All should produce NO OUTPUT:
```bash
# Worker doesn't import from src/server/
grep -RE "from '\.\./\.\./server" src/queue/ 2>/dev/null || true
grep -RE "from '\.\./\.\./\.\./server" src/queue/ 2>/dev/null || true

# Worker doesn't introduce new external deps (check package.json was unchanged except for the scripts field)
git diff HEAD~14 -- package.json | grep -E "^\+.*\":" | grep -vE "(scripts|enqueue-grade|tsx)" || true
```

- [ ] **Step 6: Confirm commit count**

Run: `git log --oneline <plan-5-base-sha>..HEAD | wc -l`
Expected: ~13 commits (one per task, give or take).

- [ ] **Step 7: No code changes to commit here**

Task 14 is verification-only. If any step above turns up an issue, fix it and commit. Otherwise, hand off to `finishing-a-development-branch`.

---

## Plan 5 completion checklist

Before marking this plan complete:

- [ ] All 14 tasks committed.
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green (unit only; ~256 total).
- [ ] `pnpm test:integration` green (events + store-clear-artifacts + run-grade).
- [ ] `pnpm build` green — worker bundle regenerates.
- [ ] No new runtime or dev dependencies.
- [ ] No imports from `src/server/` anywhere in `src/queue/`.
- [ ] Dev CLI (`pnpm enqueue-grade https://...`) can be invoked manually if you want to smoke-test the full pipeline (requires worker + docker-compose up).

## Out of scope (reminder)

- `POST /grades` + rate limiting + SSE HTTP endpoint → Plan 6
- Auth / magic link → Plan 7
- Stripe + recommendations + `generate-report` worker → Plan 8
- Report HTML/PDF → Plan 9
- Real-provider integration tests (indefinitely deferred; dev CLI is the manual smoke test)
- Cancel / abort a running grade → post-MVP
- Per-provider rate-limit queues / backpressure → post-MVP
- Observability (OTel, structured tracing) → Plan 10
