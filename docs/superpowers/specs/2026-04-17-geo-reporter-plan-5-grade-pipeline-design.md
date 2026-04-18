# GEO Reporter — Plan 5 (Grade pipeline worker) design

> Sub-spec for Plan 5. Expands master spec §4.3 (end-to-end trace — free grade). Locks in eight decisions from brainstorming on 2026-04-17.

## 1. Scope

Plan 5 is the **run-grade BullMQ worker** that wires Plans 2, 3, and 4 into a runnable grade pipeline. Input: a `run-grade` job `{ gradeId, tier }`. Output: populated `scrapes`/`probes` rows + a finalized `grades` row + a stream of SSE-consumable events on Redis channel `grade:<gradeId>`.

Library-plus-one-entrypoint. No Hono, no HTTP routes, no rate limit, no auth, no Stripe, no recommendations, no report rendering.

## 2. Decisions locked in on 2026-04-17

| # | Decision | Choice | Why |
|---|---|---|---|
| P5-1 | Dev CLI | Ship `scripts/enqueue-grade.ts` | ~20 lines of glue makes the worker demo-able end-to-end before Plan 6's HTTP layer lands. |
| P5-2 | Pub/sub helpers | Publisher AND subscriber together in `src/queue/events.ts` | Publisher and subscriber share the channel format + event schema — they belong as one tested unit. Integration tests genuinely want `subscribeToGrade`. |
| P5-3 | Specialty provider roles | Claude plays judge, accuracy generator, and accuracy verifier | Simplest mapping; self-judging bias is within MVP tolerance; no other role is special enough to warrant a different provider. Easy to invert later. |
| P5-4 | Persistence timing | Write-through; `DELETE FROM scrapes/probes WHERE grade_id = :id` at attempt start | SSE comes from real DB commits (reconnecting clients can hydrate via SELECT); clear-on-retry gives BullMQ retries a clean slate without in-memory state. |
| P5-5 | Category orchestration | SEO serial first, then 5 LLM categories in parallel (`Promise.all`) | SEO is sync — gives a satisfying first progress tick. LLM categories are independent; parallelizing cuts grade latency ~5×. Rate-limit pressure is manageable (<10 req/provider). |
| P5-6 | SSE event granularity | Per-probe (`probe.started` + `probe.completed` + `category.completed` + lifecycle events) | Spec §4.3 step 5d calls for per-probe progress. v1's terminal aesthetic is live per-probe output. ~50 messages / 60s per grade is trivial for Redis pub/sub. |
| P5-7 | Accuracy + Coverage → `probes` rows | Accuracy: 1 generator row + N answer rows (A1). Coverage: 2N rows, each with judge's per-probe accuracy+coverage averaged into `score` (C1). No separate judge-summary row. | Keeps `provider=null` semantics reserved for SEO. Judge metadata lives in each Coverage probe's `metadata.judgeAccuracy` / `.judgeCoverage` / `.judgeNotes` / `.judgeDegraded`. |
| P5-8 | Error policy | Always-finalize. Hard-fail only on: DB/Redis down, scrape < 100 chars even after Playwright, or every single LLM call fails. Everything else records error in probe row, keeps going. | Users see a partial grade ("we couldn't score X") rather than a bare error page. Matches Plan 4's per-probe soft-failure model. |

## 3. Architecture

Plan 5 adds one top-level folder plus one file at the top of `src/queue/`, modifies the worker entrypoint, and introduces one dev script.

```
src/queue/
├── events.ts                             NEW — pub/sub helpers + GradeEvent union
└── workers/
    ├── health.ts                         (existing)
    └── run-grade/                        NEW — one folder because the worker is substantial
        ├── index.ts                        registerRunGradeWorker(deps, connection)
        ├── run-grade.ts                    runGrade(job, deps) — the Processor function
        ├── categories.ts                   runXxxCategory helpers + collapseToCategoryScore
        └── deps.ts                         RunGradeDeps interface + GradeFailure error class

src/worker/worker.ts                       MODIFY — register the new worker
src/config/env.ts                          MODIFY — tighten API-key fields to required in production
src/store/postgres.ts                      MODIFY — add clearGradeArtifacts method
src/store/types.ts                         MODIFY — add clearGradeArtifacts to GradeStore interface

scripts/
└── enqueue-grade.ts                      NEW — dev CLI

tests/unit/queue/
└── workers/run-grade/
    ├── categories.test.ts                 collapseToCategoryScore + the per-category adapter pure-math bits
    └── run-grade.test.ts                  whole Processor with fake deps (MockProvider + in-memory scrape + ioredis-mock)

tests/integration/
├── events.test.ts                         pub/sub roundtrip with testcontainers Redis
└── run-grade.test.ts                      end-to-end: testcontainers pg + redis + MockProvider probers
```

**Invariants:**

- Worker makes no direct HTTP calls. All outbound I/O goes through injected deps.
- Every DB write is funneled through `GradeStore` (store seam).
- Worker imports from `src/scraper/`, `src/seo/`, `src/llm/`, `src/scoring/`, `src/accuracy/`, `src/store/`, `src/queue/events.ts`, `src/db/`.
- Worker does **not** import from `src/server/`. Prevents HTTP creep.

## 4. Event schema (`src/queue/events.ts`)

Redis channel format: `grade:<gradeId>`. Payload: one JSON-encoded `GradeEvent` per message.

```ts
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
  | {
      type: 'done'
      overall: number
      letter: string
      scores: Record<CategoryId, number | null>
    }
  | { type: 'failed'; error: string }

export function publishGradeEvent(
  redis: Redis,
  gradeId: string,
  event: GradeEvent,
): Promise<void>

export function subscribeToGrade(
  redis: Redis,
  gradeId: string,
  signal?: AbortSignal,
): AsyncIterable<GradeEvent>
```

### `label` conventions per category

| Category | Emitted probe events per provider | `label` values |
|---|---|---|
| `seo` | one per signal (10 signals, provider=null) | signal name (`title`, `description`, …) |
| `recognition` | 2 per provider (2 static prompts) | `prompt_1`, `prompt_2` |
| `citation` | 1 per provider | `official-url` |
| `discoverability` | 1 per provider (self-gen flow is atomic) | `self-gen` |
| `coverage` | 2 per provider (2 static prompts, score is post-judge) | `prompt_1`, `prompt_2` |
| `accuracy` | 1 `generator` event + 1 `verify` event per probe-answer | `generator`, `verify` |

### Subscriber semantics

- `subscribeToGrade` uses the connection the caller hands in. That connection becomes pub/sub-locked (ioredis rule) and must be separate from any command-issuing connection. Caller manages lifecycle.
- No buffering / replay. Events fire once on Redis pub/sub; late subscribers miss prior events. Plan 6's SSE handler hydrates missed state via `SELECT probes WHERE grade_id` on reconnect.
- Events for a single `gradeId` arrive in publish order to any single subscriber (single worker process is the sole publisher).
- `subscribeToGrade` terminates cleanly when the event with `type: 'done'` or `type: 'failed'` is received, OR when the AbortSignal fires, OR when the underlying connection closes.

## 5. Job lifecycle

```
runGrade(job, deps):
  { gradeId, tier } = job.data
  probers = tier === 'free' ? [claude, gpt] : [claude, gpt, gemini, perplexity]
  judge = claude, generator = claude, verifier = claude

  try:
    store.updateGrade(gradeId, { status: 'running' })
    publishGradeEvent(redis, gradeId, { type: 'running' })

    // Clear-on-retry (P5-4)
    store.clearGradeArtifacts(gradeId)      // DELETE scrapes + probes atomically

    // Scrape step
    grade = store.getGrade(gradeId); if (!grade) throw 'grade not found'
    scrape = await deps.scrapeFn(grade.url)
    if (scrape.text.length < 100) throw new GradeFailure('scrape produced < 100 chars')
    store.createScrape({ gradeId, ... })
    publishGradeEvent(..., { type: 'scraped', rendered, textLength })

    // Category orchestration (P5-5)
    seoScore = await runSeoCategory({ gradeId, scrape, deps })
    [recScore, citScore, discScore, covScore, accScore] = await Promise.all([
      runRecognitionCategory(...), runCitationCategory(...),
      runDiscoverabilityCategory(...), runCoverageCategory(..., judge),
      runAccuracyCategory(..., generator, verifier),
    ])

    // Finalize
    scores = { discoverability, recognition, accuracy, coverage, citation, seo }
    overall = weightedOverall(scores, DEFAULT_WEIGHTS)
    store.updateGrade(gradeId, { status: 'done', overall: overall.overall, letter: overall.letter, scores })
    publishGradeEvent(..., { type: 'done', overall, letter, scores })

  catch err:
    message = err instanceof Error ? err.message : String(err)
    store.updateGrade(gradeId, { status: 'failed' })
    publishGradeEvent(..., { type: 'failed', error: message })
    throw err   // BullMQ counts the attempt
```

BullMQ retries the whole job up to 3x on any throw (settings already set in `src/queue/queues.ts`). Each retry's clear-on-retry step guarantees a clean slate.

## 6. Category adapters (`src/queue/workers/run-grade/categories.ts`)

Each adapter is a small function that:

1. For each probe it runs, publishes `probe.started` immediately before the LLM call.
2. Executes the LLM call via the corresponding Plan 4 flow function.
3. On success: writes a probe row via `store.createProbe`, records score, publishes `probe.completed` with score + latency.
4. On per-probe error: writes a probe row with `response=''`, `score=null`, `metadata.error=message`, publishes `probe.completed` with `score: null, error: message`. Does NOT throw.
5. Collapses all per-probe scores via `collapseToCategoryScore` into the category score.
6. Publishes `category.completed` with the collapsed score.
7. Returns the category score.

### `collapseToCategoryScore`

```ts
export function collapseToCategoryScore(scores: (number | null)[]): number | null {
  const numeric = scores.filter((s): s is number => s !== null)
  if (numeric.length === 0) return null
  return Math.round(numeric.reduce((a, b) => a + b, 0) / numeric.length)
}
```

### Per-category notes

**SEO (`runSeoCategory`)** — synchronous. Calls `evaluateSeo(scrape)` (from Plan 3), iterates signals. One `probe` row per signal: `category='seo'`, `provider=null`, `prompt=signalName`, `response=detail`, `score=pass ? 100 : 0`, `metadata={ signal: name, weight, pass }`. Uses `evaluateSeo`'s pre-computed `score` directly — does NOT re-collapse per signal (the 10/total math is already done in Plan 3).

**Recognition** — `runStaticProbe` × 2 prompts × N providers, scorer = `scoreRecognition({ text, domain })`. Label = `prompt_1` / `prompt_2`. Metadata stores `{ label, latencyMs, inputTokens, outputTokens }`.

**Citation** — `runStaticProbe` × 1 prompt × N providers, scorer = `scoreCitation({ text, domain })`. Label = `official-url`.

**Discoverability** — `runSelfGenProbe` × N providers. Scorer passed in: `(args) => scoreDiscoverability(args)`. Label = `self-gen`. Probe row stores stage-2's `{ prompt, response, score }`; stage-1 (generator) info goes in `metadata.generator = { prompt, response, latencyMs, inputTokens, outputTokens }`.

**Coverage** — one `runCoverageFlow({ providers, judge, groundTruth })` call per job, returns `{ probes, judge: JudgeResult }`. Adapter unpacks:
- 2N probe rows (2 prompts × N providers). Each row gets:
  - `category='coverage'`, `provider=<id>`, `prompt`, `response`
  - `score = round((perProbe.accuracy + perProbe.coverage) / 2)` where `perProbe = judge.perProbe.get(...)` (or `null` if the probe failed or the judge degraded)
  - `metadata = { label: 'prompt_1' | 'prompt_2', latencyMs, inputTokens, outputTokens, judgeAccuracy, judgeCoverage, judgeNotes, judgeDegraded }`
- No separate judge row. Judge's prompt + rawResponse are not persisted (reconstructable; mostly useful for debugging, not worth the column).
- `probe.started` / `probe.completed` for each of the 2N probes. If `judge.degraded === true`, Plan 4's heuristic fallback populated `perProvider` only — `perProbe` is empty Map — so per-probe scores all collapse to `null` for this run; only the (still produced) heuristic per-provider score is usable. For MVP we use the heuristic-collapsed per-provider score on each matching probe row.

**Accuracy** — one `runAccuracy({ generator, verifier, probers, url, scrape })` call per job, returns `AccuracyResult`. Adapter unpacks:

- **One generator row** (category='accuracy', provider=generator's id='claude', prompt=generator prompt, response=generated question, score=null, metadata=`{ role: 'generator', latencyMs, inputTokens, outputTokens }`). Emits `probe.started` / `probe.completed` with `label: 'generator'`, `score: null`.
- **N answer rows**, one per prober (category='accuracy', provider=prober's id, prompt=the generated question, response=the LLM's answer, score=`verification.correct === true ? 100 : verification.correct === false ? 0 : null`, metadata=`{ role: 'verify', confidence, rationale, degraded, generatorProbeId: <the generator row's id>, verifierProviderId: 'claude', latencyMs: probe.latencyMs, inputTokens: probe.inputTokens, outputTokens: probe.outputTokens }`). Emits `probe.started` / `probe.completed` with `label: 'verify'`.
- **Special-case reason branches** — when `result.reason` is `'insufficient_scrape'`, `'all_null'`, or `'all_failed'`:
  - `scores.accuracy = null` → dropped by `weightedOverall`
  - One probe row with `category='accuracy'`, `provider=null`, `prompt=''`, `response=''`, `score=null`, `metadata={ role: 'skipped', reason: result.reason }` — so a future report can explain why accuracy was unscored. No generator row in this branch.
  - Emits `category.completed` with `score: null` and skips the individual probe events.

### Error propagation

- A provider throwing inside any `runXxxCategory` gets caught at the adapter; probe row with `error` recorded; adapter continues.
- `runSelfGenProbe` throws if either stage fails (Plan 4 contract). Adapter catches and records a single failed probe row for that provider.
- `runCoverageFlow` doesn't throw for per-probe failures (already handled internally); it DOES throw if the judge call itself throws (connection failure). Adapter catches, collapses to a degraded `JudgeResult` shape internally (empty perProbe, empty perProvider, degraded: true), writes 2N probe rows with null scores, emits events, returns null category score.
- `runAccuracy` throws if the generator itself throws (Plan 4 contract). Adapter catches, writes a skipped row per above, emits events, returns null.

## 7. Dev CLI (`scripts/enqueue-grade.ts`)

Usage: `pnpm tsx scripts/enqueue-grade.ts <url> [--paid]`.

Responsibilities:
- Parse args, derive domain from URL.
- Mint a synthetic cookie UUID, upsert a `cookies` row.
- Create a `grades` row with status='queued', tier inferred from `--paid` flag.
- Enqueue a `run-grade` job via `enqueueGrade` (already in `src/queue/queues.ts`).
- Print `enqueued grade <id> (tier=<tier>) for <url>` + a `redis-cli subscribe grade:<id>` hint.

A `package.json` script `"enqueue-grade": "tsx scripts/enqueue-grade.ts"` is added for convenience.

No tests for the CLI itself — it's thin glue and its underlying components (store, queue) are tested elsewhere.

## 8. `GradeStore` additions

```ts
// src/store/types.ts
export interface GradeStore {
  // ... existing methods
  clearGradeArtifacts(gradeId: string): Promise<void>
  // Deletes rows from probes and scrapes where grade_id = $1.
  // Implementation MUST be atomic (single transaction). Used by the worker's
  // clear-on-retry step to ensure BullMQ retries start clean.
}
```

`PostgresStore` implementation (~10 lines): one transaction, two DELETEs.

## 9. Env schema tightening (`src/config/env.ts`)

Plan 4 added 4 API keys as optional. Plan 5 tightens to required-in-production via a Zod `superRefine`:

```ts
}).superRefine((val, ctx) => {
  if (val.NODE_ENV === 'production') {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY'] as const) {
      if (!val[key]) ctx.addIssue({ code: 'custom', message: `${key} is required in production`, path: [key] })
    }
  }
})
```

Local dev + tests + CI still run without keys (all use MockProvider).

## 10. Worker entrypoint changes

`src/worker/worker.ts` (existing file) gets modified to:
- Build a `PostgresStore` from the existing `db` import.
- Build `DirectProviders` via `buildProviders(env)` — throws at startup if production keys are missing.
- Register both `registerHealthWorker` (existing) and `registerRunGradeWorker` (new).
- Shutdown handler already exists; no changes needed beyond adding new workers to the close list.

## 11. Testing strategy

### Unit tests (no I/O, MockProvider everywhere)

- `tests/unit/queue/workers/run-grade/categories.test.ts`
  - `collapseToCategoryScore`: all-numbers, numbers+nulls, all-nulls, empty. ~4 tests.
  - Optionally, individual adapter tests if helpers get extracted. Typically covered via run-grade.test.ts instead.

- `tests/unit/queue/workers/run-grade/run-grade.test.ts`
  - Happy path free tier (2 probers, all providers succeed, all categories produce non-null scores).
  - Happy path paid tier (4 probers).
  - Hard-fail: scrape < 100 chars → throws, status='failed'.
  - Hard-fail: grade row missing → throws.
  - Soft-fail: one provider throws consistently → its probes are null, others count, grade finalizes.
  - Soft-fail: accuracy `insufficient_scrape` → accuracy=null, dropped from weightedOverall, skipped probe row written, no generator/verify rows.
  - Soft-fail: accuracy `all_null` and `all_failed` branches (similar shape).
  - Clear-on-retry: second invocation for same gradeId calls `clearGradeArtifacts` once before doing anything else.
  - Event order: `running` first; `scraped` before any category events; `category.completed` before `done`.
  - Total: ~12-15 tests.

### Integration tests (testcontainers)

- `tests/integration/events.test.ts`
  - Publish all 7 event variants, subscribe, verify receipt.
  - Multiple subscribers receive same events.
  - AbortSignal early-close terminates the async iterator.
  - Subscriber terminates on `done` / `failed` event.
  - ~4 tests.

- `tests/integration/run-grade.test.ts`
  - Full end-to-end: testcontainers pg+redis, PostgresStore, MockProvider × 4, stub scrapeFn → enqueue → spawn worker → subscribe → assert event sequence + DB state.
  - Free tier probe counts: 10 SEO + 4 recognition + 2 citation + 2 discoverability + 4 coverage + 3 accuracy (1 gen + 2 verify) = **25 probe rows**.
  - Paid tier probe counts: 10 + 8 + 4 + 4 + 8 + 5 (1 gen + 4 verify) = **39 probe rows**.
  - Retry test: inject a failing provider, assert BullMQ attempts=2, final probes count matches a single successful attempt (clear-on-retry worked).
  - Status transitions: queued → running → done.
  - Scores JSON shape in grades row matches `Record<CategoryId, number | null>`.
  - ~6-8 tests.

**No real LLM calls anywhere in Plan 5.** All four providers use `MockProvider` fixtures. **No real Playwright.** Integration tests inject a fixture `scrapeFn`.

## 12. Out of scope

- `POST /grades` HTTP endpoint (Plan 6)
- Rate limiting, IP+cookie bucket enforcement (Plan 6)
- Auth / email gate / magic link / quota-lift (Plan 7)
- SSE HTTP endpoint that consumes `subscribeToGrade` and forwards to the browser (Plan 6)
- Stripe checkout + paid-tier provider top-up + recommendations LLM (Plan 8)
- `generate-report` / `render-pdf` workers (Plans 8, 9)
- React report UI and HTML SSR (Plan 9)
- Real-provider integration tests (deferred; dev CLI is the manual smoke test)
- Per-provider rate-limit queues, advanced backpressure (later ops plan)
- Cancel / abort a running grade (not in MVP)
- Observability / OTel tracing / metrics export (Plan 10)

## 13. Relationship to master spec §4.3

This sub-spec expands §4.3 step 5 (worker lifecycle) with implementation-level decisions. Specifically:

- §4.3 step 5a (scrape + Playwright fallback) is delegated to Plan 2's `scrape()`; worker passes the result through. Hard-fail threshold is 100 chars (tighter than the "< 1000 chars → fallback" that Plan 2's internal logic already does).
- §4.3 step 5b (emit `{ phase: 'scraped' }`) implemented as the `{ type: 'scraped', rendered, textLength }` event variant.
- §4.3 step 5c (SEO in parallel with per-signal probes) implemented as the `runSeoCategory` adapter — serial within SEO (cheap), parallel with the LLM categories.
- §4.3 step 5d (per-provider Recognition/Citation/Discoverability probes) implemented as the static-probe and self-gen adapters.
- §4.3 step 5e (accuracy flow) implemented via Plan 4's `runAccuracy`, unpacked per P5-7's A1 schema.
- §4.3 step 5f (judge aggregates into per-category scores) implemented via `collapseToCategoryScore` + `weightedOverall`.
- §4.3 step 5g (finalize) implemented via the final `updateGrade` + `done` event.

After this spec is approved, the master spec §4.3 should be amended with a short "Plan 5 interpretation calls" block pointing at this document — mirroring the Plan 3 pattern in §5.4 and Plan 4 in §5.3.
