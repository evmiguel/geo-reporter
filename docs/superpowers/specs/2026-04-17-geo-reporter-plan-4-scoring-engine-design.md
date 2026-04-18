# GEO Reporter — Plan 4 (Scoring engine) design

> Sub-spec for Plan 4. Expands §5 of the master design (`2026-04-17-geo-reporter-design.md`). Locks in seven interpretation calls from brainstorming on 2026-04-17.

## 1. Scope

Plan 4 builds the **scoring engine**: the library that turns a `ScrapeResult` (Plan 2) plus live LLM access into per-category scores and a weighted overall.

Library-only. No HTTP, no DB, no queue, no BullMQ, no SSE, no tier logic. Plan 5's pipeline worker composes these library functions into a grade run and handles all persistence.

## 2. Decisions locked in on 2026-04-17

| # | Decision | Choice | Why |
|---|---|---|---|
| P4-1 | Provider set | 4 direct clients (Anthropic, OpenAI, Gemini, Perplexity) + `MockProvider` | Drop OpenRouter — BullMQ retry covers its fallback role. `MockProvider` is essential so Plan 4 ships with ~110 unit tests that burn zero tokens. |
| P4-2 | Module layout | Three top-level sibling folders: `src/llm/`, `src/scoring/`, `src/accuracy/` | Enforces "network-touching" vs "pure-math" separation at the filesystem level. Accuracy gets its own folder because it's a novel multi-step flow, testable as a unit. |
| P4-3 | Scrape → judge bridge | Keep v1's flat `GroundTruth` as an internal type; add `toGroundTruth(url, scrape)` helper | Judge and prompts stay near-verbatim from v1; only one small adapter touches `ScrapeResult`. |
| P4-4 | Accuracy verifier shape | One verifier call **per provider**, in parallel | Per-probe failures stay isolated; cost delta (1 vs 4 calls of a cheap model) is dwarfed by the blind probes on real target models. |
| P4-5 | Sparse/dense judge | One unified judge prompt with a conditional clause | Collapses v1's two ~80%-duplicated prompts into one builder with one test surface. `isSparseGroundTruth(gt)` still triggers the "use your own knowledge" branch. |
| P4-6 | Cost tracking | Return `{ inputTokens, outputTokens }`; drop `costUsd` and `prices.ts` | Dollar math drifts; token counts come free from provider APIs. Cost reporting, if ever needed, is a read-time computation — not a library concern. |
| P4-7 | Multi-step flow orchestration | Plan 4 exposes **flow functions** (`runStaticProbe`, `runSelfGenProbe`, `runCoverageFlow`, `runAccuracy`), not just building blocks | Category-specific shape belongs with the scoring logic, not the worker. Plan 5 becomes pipeline plumbing over a testable engine. |

## 3. Module layout

```
src/
├── llm/                                  — anything that makes an LLM network call
│   ├── providers/
│   │   ├── types.ts                        Provider, QueryResult, QueryOpts, ProviderId
│   │   ├── errors.ts                       ProviderError (kind: rate_limit | auth | server | timeout | network | unknown)
│   │   ├── anthropic.ts                    AnthropicProvider
│   │   ├── openai.ts                       OpenAIProvider
│   │   ├── gemini.ts                       GeminiProvider
│   │   ├── perplexity.ts                   PerplexityProvider
│   │   ├── mock.ts                         MockProvider (records calls; configurable responses)
│   │   ├── factory.ts                      buildProviders(env) → { claude, gpt, gemini, perplexity }
│   │   └── index.ts                        re-exports
│   ├── prompts.ts                          all prompt builders (pure string functions)
│   ├── ground-truth.ts                     GroundTruth type, toGroundTruth, isSparseGroundTruth
│   ├── judge.ts                            runJudge (calls promptJudge, parses JSON, heuristic fallback)
│   └── flows/
│       ├── static-probe.ts                 runStaticProbe
│       ├── self-gen.ts                     runSelfGenProbe (Discoverability pattern)
│       └── coverage.ts                     runCoverageFlow (Coverage pattern)
│
├── scoring/                              — pure math; no imports from src/llm/ or src/scraper/
│   ├── recognition.ts                      scoreRecognition
│   ├── citation.ts                         scoreCitation
│   ├── discoverability.ts                  scoreDiscoverability, brandFromDomain
│   ├── letter.ts                           toLetterGrade
│   ├── weights.ts                          CategoryId, DEFAULT_WEIGHTS
│   └── composite.ts                        weightedOverall (drops null categories, renormalizes)
│
└── accuracy/                             — novel generator + blind-probe + verifier flow
    ├── generator.ts                        generateQuestion
    ├── verifier.ts                         verifyAnswer (one call per probed provider)
    └── index.ts                            runAccuracy (the end-to-end flow)
```

**Enforced invariants:**

- `src/scoring/` has zero imports from `src/llm/`, `src/scraper/`, `src/seo/`, `src/db/`, `src/queue/`, `src/store/`. Pure math only.
- `src/llm/` has no imports from `src/db/`, `src/queue/`, `src/store/`, `src/server/`, `src/worker/`.
- `src/accuracy/` imports from `src/llm/` and `src/scraper/` types, but not from `src/scoring/`.
- Existing `src/scraper/` and `src/seo/` are untouched.
- Plan 5 imports from all three modules via `src/index.ts`.

## 4. Provider layer (`src/llm/providers/`)

**Contract** (`types.ts`):

```ts
export type ProviderId = 'claude' | 'gpt' | 'gemini' | 'perplexity' | 'mock'

export interface QueryResult {
  text: string
  ms: number
  inputTokens: number
  outputTokens: number
}

export interface QueryOpts {
  maxTokens?: number    // default 2048
  temperature?: number  // probes default 0.7, judge/verifier default 0
  signal?: AbortSignal  // Plan 5 hook for timeout/cancellation
}

export interface Provider {
  readonly id: ProviderId
  query(prompt: string, opts?: QueryOpts): Promise<QueryResult>
}
```

**Differences from v1:**

- `via: 'direct' | 'openrouter'` — **removed** (OpenRouter is out of scope per P4-1).
- `raw: unknown` — **removed** (unused downstream).
- `costUsd: number` — **removed** (per P4-6).
- `signal?: AbortSignal` — **added** so Plan 5 can cancel stuck calls.

**Direct clients** — one class per provider. Constructor shape: `{ apiKey: string, model?: string, fetchFn?: typeof fetch }`. `fetchFn` injection is what makes unit tests possible without hitting the network. Default models are chosen at plan-writing time from each provider's "fast + cheap" tier.

**`ProviderError`** (`errors.ts`):

```ts
export type ProviderErrorKind = 'rate_limit' | 'auth' | 'server' | 'timeout' | 'network' | 'unknown'

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number | null,
    readonly kind: ProviderErrorKind,
    message: string,
  )
}
```

Every direct client classifies its failures into one of the six kinds. Plan 5 reads `err.kind` to decide retry policy — keeps retry semantics centralized in Plan 5 while keeping the "is this retryable?" judgment in the provider layer (which has the HTTP context).

**`MockProvider`** — constructor takes `{ id: ProviderId, responses: Record<string, string> | ((prompt: string) => string) }`. Records every call in a public `calls: Array<{ prompt, opts }>` so tests can assert the prompt content. Used in every unit test that touches a flow, judge, or accuracy function.

**`buildProviders(env)`** — small factory that constructs all four real providers from env keys. Returns a keyed object `{ claude, gpt, gemini, perplexity }`. Plan 5 calls this once at worker startup.

**New env vars** (added to `src/config/env.ts` Zod schema in Task 1 of the implementation plan):

```
ANTHROPIC_API_KEY    string, required in production, optional in test
OPENAI_API_KEY       string, required in production, optional in test
GEMINI_API_KEY       string, required in production, optional in test
PERPLEXITY_API_KEY   string, required in production, optional in test
```

CI runs `pnpm test` with no real keys — every test uses `MockProvider`. Real-provider smoke-testing is deferred to Plan 5.

## 5. Prompts and the scrape bridge

**`src/llm/ground-truth.ts`**:

```ts
export interface GroundTruth {
  url: string
  domain: string        // new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  title: string         // from scrape.structured.meta.title
  description: string   // from scrape.structured.meta.description
  h1: string            // from scrape.structured.headings.h1[0] ?? ''
  bodyExcerpt: string   // scrape.text.slice(0, 2000).trim()
}

export function toGroundTruth(url: string, scrape: ScrapeResult): GroundTruth
export function isSparseGroundTruth(gt: GroundTruth): boolean
  // total length of (description + h1 + bodyExcerpt) < 100 chars → true
```

**`src/llm/prompts.ts` — seven exports:**

1. **`promptRecognition(domain): [string, string]`** — the two static recognition prompts: `What is ${domain}?` and `Have you heard of ${domain}? If so, what is it known for?`. Caller runs both and averages the scores.

2. **`promptCoverage(domain): [string, string]`** — two static coverage prompts: `What does ${domain} do? List their main products or services.` and `Who is the target audience for ${domain}?`. Used by `runCoverageFlow`.

3. **`promptCitation(domain): string`** — `What is the official website for ${domain}? Provide the URL.`

4. **`promptDiscoverabilityGenerator(gt): string`** — v1's `buildSelfGenPrompt` verbatim. Asks the provider to imagine a customer-style question about the site *without naming the site*. Output is fed back to the same provider as `runSelfGenProbe`'s stage-2 prompt.

5. **`promptJudge(gt, probes): { prompt: string, probesByKey: Map<string, ProbeForJudge> }`** — unified sparse/dense (P4-5). Internally branches on `isSparseGroundTruth(gt)`:
   - **Dense branch:** full scrape excerpt included; instructs the judge to use the scrape as primary grounding, own knowledge as backup ("a response that knows more than the homepage shows should still score high").
   - **Sparse branch:** only URL/title included; instructs the judge to use its own knowledge of the site ("the scrape is essentially empty; do not use it as a fact-check basis").
   - Both branches emit the same JSON output schema: `{ "probe_N": { accuracy, coverage, notes } }`.

6. **`promptAccuracyGenerator(gt): string`** — new in v3. Cheap-model prompt: "Write one specific factual question a visitor would reasonably ask about this company that the scraped content clearly answers. Return only the question." Input is the full `gt` (all fields). Output: single question string.

7. **`promptAccuracyVerifier({ gt, question, providerId, answer }): string`** — new in v3. Judge prompt for one provider's answer. Input: scrape excerpt + question + one answer + providerId. Output schema: `{ correct: true | false | null, confidence: 0..1, rationale: string }`. `correct: null` means "the scrape doesn't support a definitive judgment" — instructs the judge explicitly.

**`ProbeForJudge` type** (defined alongside `GroundTruth`):

```ts
export interface ProbeForJudge {
  key: string                   // 'probe_1', 'probe_2', ... — used as JSON key
  provider: ProviderId
  category: 'coverage'          // only coverage probes go through the judge
  prompt: string
  response: string
}
```

Plan 5's DB `probes` rows are mapped to `ProbeForJudge[]` at the `runJudge` call site.

**Testing:** one golden-string test per prompt builder (~15 tests). These catch accidental prompt drift in future edits; cheap.

## 6. Judge runner (`src/llm/judge.ts`)

```ts
export interface ProbeJudgement {
  accuracy: number   // 0-100
  coverage: number   // 0-100
  notes: string
}

export interface JudgeResult {
  prompt: string
  rawResponse: string
  perProbe: Map<string, ProbeJudgement>
  perProvider: Partial<Record<ProviderId, ProbeJudgement>>
  degraded: boolean
}

export function runJudge(input: {
  judge: Provider,
  groundTruth: GroundTruth,
  probes: ProbeForJudge[],
  signal?: AbortSignal,
}): Promise<JudgeResult>
```

**Algorithm** (ported from v1's proven `runJudge`):

1. Build prompt with `promptJudge(gt, probes)`.
2. Call `judge.query(prompt, { temperature: 0 })`.
3. Extract JSON via fallbacks: raw body → fenced code block → first-brace-to-last-brace substring → deeply-nested object if top-level is `{ scores: {...} }`.
4. Parse attempts normalize synthetic probe keys (`probe_1` → probe.id) into `Map<probeId, ProbeJudgement>`.
5. On parse failure, retry once with a stricter suffix: `IMPORTANT: Respond with ONLY a JSON object, no prose, no code fences, no preamble.`
6. On second failure, return `{ degraded: true, perProbe: empty Map, perProvider: heuristicFallback(probes, gt) }`.

**Heuristic fallback** — vocabulary-overlap scoring with a baseline of 60 (so a substantive response that happens to share no vocab with a sparse scrape still scores middling, not zero). Ported from v1.

**`perProvider` aggregation** — group `perProbe` entries by probe's provider, average accuracy and coverage per group, join notes with `|`. Same as v1's `aggregateByProvider`.

**Naming note:** `ProbeJudgement.accuracy` is the judge's *internal dimension* on each Coverage probe (how factually sound the answer is), **not** the v3 Accuracy category (which has its own dedicated flow in `src/accuracy/`). Two distinct concepts that happen to share a word; keeping v1's field names preserves the prompt's exact phrasing, which matters for LLM output stability.

## 7. Flow functions (`src/llm/flows/`)

### 7.1 `runStaticProbe`

```ts
export interface StaticProbeResult {
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  score: number | null           // null if no scorer supplied
  scoreRationale: string | null
}

export function runStaticProbe(input: {
  provider: Provider,
  prompt: string,
  scorer?: (response: string) => { score: number, rationale: string },
  signal?: AbortSignal,
}): Promise<StaticProbeResult>
```

Used by **Recognition** (runs both recognition prompts, scorer = `scoreRecognition`) and **Citation** (runs citation prompt, scorer = `scoreCitation`). Caller composes recognition's two probes (one per prompt, average the scores).

Error semantics: if `provider.query` throws, `runStaticProbe` re-throws — no fallback. Plan 5 catches and records the failure.

### 7.2 `runSelfGenProbe`

```ts
export interface SelfGenProbeResult {
  generator: { prompt: string, response: string, latencyMs: number, inputTokens: number, outputTokens: number }
  probe:     { prompt: string, response: string, latencyMs: number, inputTokens: number, outputTokens: number }
  score: number
  scoreRationale: string
}

export function runSelfGenProbe(input: {
  provider: Provider,                  // SAME provider for both stages
  groundTruth: GroundTruth,
  scorer: (args: { text: string, brand: string, domain: string }) => number,
  signal?: AbortSignal,
}): Promise<SelfGenProbeResult>
```

The **Discoverability** pattern, ported from v1's `grade.ts:340-440`:

1. Stage 1 — call `provider.query(promptDiscoverabilityGenerator(gt))`. Output: customer-style question.
2. Stage 2 — call the **same** provider with the generated question (no ground-truth context).
3. Score stage-2 response via `scorer({ text, brand: brandFromDomain(gt.domain), domain: gt.domain })`.

If stage 1 throws, the function throws (no meaningful fallback — we have no question to probe). If stage 2 throws, the function throws. Plan 5 catches per-provider.

### 7.3 `runCoverageFlow`

```ts
export interface CoverageProbe {
  provider: ProviderId
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  error: string | null
}

export interface CoverageFlowResult {
  probes: CoverageProbe[]
  judge: JudgeResult
}

export function runCoverageFlow(input: {
  providers: Provider[],         // 2 free, 4 paid — caller decides
  judge: Provider,               // typically Claude; caller decides
  groundTruth: GroundTruth,
  signal?: AbortSignal,
}): Promise<CoverageFlowResult>
```

Runs `promptCoverage(domain)` × `providers` in parallel. Individual probe failures capture the error (`error: message, response: ''`) but don't abort the flow. After all probes settle, build `ProbeForJudge[]` from successful probes only and call `runJudge`. If all probes failed, skip judge and return `{ probes, judge: { degraded: true, perProbe: empty, perProvider: {} } }`.

**Mapping Coverage → category score** is NOT in Plan 4. The `JudgeResult.perProvider` shape returns per-provider coverage numbers; Plan 5 knows which providers count (tier-dependent) and averages them into a single `coverage` category score.

## 8. Pure scoring (`src/scoring/`)

**`scoring/recognition.ts`** — `scoreRecognition({ text, domain }): number`. Verbatim port of v1's `scoreRecognition`. Rules:
- "I don't know" phrases → 0.
- Neither brand nor domain mentioned → 0.
- Otherwise: baseline 50 + bonus from substantive-hint matches (1 = +20, 2 = +35, 3+ = +50).
- Hedge phrases subtract 20.
- Clamped to 0–100.

**`scoring/citation.ts`** — `scoreCitation({ text, domain }): number`. Verbatim port:
- Canonical URL (`https?://(www\.)?domain`) → 100.
- Same-domain subdomain URL → 80.
- Bare domain token (word-boundary) → 50.
- Else → 0.

**`scoring/discoverability.ts`** — `scoreDiscoverability({ text, brand, domain }): number`. Verbatim port of v1's `scoreDiscovery`. Also exports `brandFromDomain(domain): string` (extracts second-to-last segment of hostname, drops `www.`, title-cases).

**`scoring/letter.ts`** — `toLetterGrade(score): string`. Verbatim port of v1's threshold table: 97=A+, 93=A, 90=A−, 87=B+, 83=B, 80=B−, 77=C+, 73=C, 70=C−, 60=D, else F.

**`scoring/weights.ts`**:

```ts
export type CategoryId = 'discoverability' | 'recognition' | 'accuracy' | 'coverage' | 'citation' | 'seo'

export const DEFAULT_WEIGHTS: Record<CategoryId, number> = {
  discoverability: 30,
  recognition: 20,
  accuracy: 20,
  coverage: 10,
  citation: 10,
  seo: 10,
}
```

Names match spec §5.1 (note the rename: v1's `discovery` → v3's `discoverability`). Weights sum to 100.

**`scoring/composite.ts`**:

```ts
export type CategoryScores = Partial<Record<CategoryId, number | null>>

export interface OverallScore {
  overall: number
  letter: string
  usedWeights: Record<CategoryId, number>
  droppedCategories: CategoryId[]
}

export function weightedOverall(
  scores: CategoryScores,
  weights: Record<CategoryId, number>,
): OverallScore
```

**Algorithm:**

1. Collect categories where `scores[c]` is a finite number (not `null`, not `undefined`).
2. `totalScored = sum(weights[c] for each scored c)`.
3. `weighted = sum(scores[c] * weights[c] for each scored c)`.
4. `overall = totalScored === 0 ? 0 : Math.round(weighted / totalScored)`.
5. `usedWeights` = the weight of each scored category renormalized to sum to 100 (for report display).
6. `droppedCategories` = categories in `weights` keys that weren't in `scores` OR had `null` / `undefined`.
7. `letter = toLetterGrade(overall)`.

**Why `null` is meaningful**: Plan 9's report needs to tell the user *why* a category was unscored ("accuracy was unscored because your site's scrape was too thin"). Returning `droppedCategories` on the result makes Plan 4 the source of truth for that story.

## 9. Accuracy submodule (`src/accuracy/`)

### 9.1 `generateQuestion`

```ts
export interface GeneratedQuestion {
  question: string
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export function generateQuestion(input: {
  generator: Provider,        // cheap model — caller typically passes gpt-4.1-mini or claude-haiku
  groundTruth: GroundTruth,
  signal?: AbortSignal,
}): Promise<GeneratedQuestion>
```

Build `promptAccuracyGenerator(gt)`, call `generator.query(prompt, { temperature: 0.3 })`, strip leading/trailing quotes and whitespace. No internal retry — if the generator throws, caller catches and skips accuracy for this grade.

### 9.2 `verifyAnswer`

```ts
export interface ProbeAnswer {
  providerId: ProviderId
  answer: string              // '' if the prober errored
  latencyMs: number
  inputTokens: number
  outputTokens: number
  error: string | null
}

export interface VerificationResult {
  providerId: ProviderId
  correct: boolean | null     // null = scrape doesn't support a definitive judgment
  confidence: number          // 0..1
  rationale: string
  prompt: string
  rawResponse: string
  degraded: boolean           // true if JSON parse failed and heuristic fallback was used
}

export function verifyAnswer(input: {
  verifier: Provider,
  groundTruth: GroundTruth,
  question: string,
  probeAnswer: ProbeAnswer,
  signal?: AbortSignal,
}): Promise<VerificationResult>
```

Build `promptAccuracyVerifier(...)`, call at temperature 0, parse JSON with the same fallback cascade as `runJudge` (raw → fenced → brace-substring → retry with stricter suffix). On final parse failure: `{ correct: null, confidence: 0, rationale: 'verifier parse failed', degraded: true }`.

### 9.3 `runAccuracy` — the orchestrated flow

```ts
export type AccuracyReason = 'ok' | 'insufficient_scrape' | 'all_null' | 'all_failed'

export interface AccuracyResult {
  score: number | null
  reason: AccuracyReason
  generator: GeneratedQuestion | null
  probes: ProbeAnswer[]
  verifications: VerificationResult[]
  valid: number      // count of verifications where correct !== null
  correct: number    // count of correct === true
}

export function runAccuracy(input: {
  generator: Provider,
  verifier: Provider,
  probers: Provider[],          // 2 free, 4 paid — caller decides
  url: string,
  scrape: ScrapeResult,
  signal?: AbortSignal,
}): Promise<AccuracyResult>
```

**Algorithm:**

1. **Insufficient scrape:** if `scrape.text.length < 500`, return `{ score: null, reason: 'insufficient_scrape', generator: null, probes: [], verifications: [], valid: 0, correct: 0 }`. No LLM calls.
2. Build `gt = toGroundTruth(url, scrape)`.
3. `generateQuestion({ generator, groundTruth: gt })` → `genResult`. If it throws, re-throw (caller decides).
4. In parallel across `probers`: each `prober.query(genResult.question, { temperature: 0.7 })`. Collect `ProbeAnswer[]`; on per-prober error, record `{ answer: '', error: message }` instead of throwing.
5. In parallel, call `verifyAnswer` for each `ProbeAnswer` where `answer !== ''`. Skipped probes (errored) contribute nothing to `verifications`.
6. `valid = verifications.filter(v => v.correct !== null).length`, `correct = verifications.filter(v => v.correct === true).length`.
7. **Classify reason:**
   - `valid === 0` AND every `verification.correct === null` → `reason: 'all_null'`, `score: null`.
   - `valid === 0` AND all probers errored (no verifications at all) → `reason: 'all_failed'`, `score: null`.
   - `valid > 0` → `reason: 'ok'`, `score: Math.round(correct / valid * 100)`.

The **v1 fallback for `'all_null'`** (spec §5.3) — "fall back to v1's pre-scrape method" — is **not** in Plan 4. `runAccuracy` returns `score: null` and Plan 5 decides whether to substitute a fallback category score and flag it in the report.

## 10. Public surface (`src/index.ts`)

Appended to the existing Plans 1-3 re-exports:

```ts
// Providers
export type { Provider, ProviderId, QueryOpts, QueryResult } from './llm/providers/types.ts'
export { AnthropicProvider, OpenAIProvider, GeminiProvider, PerplexityProvider, MockProvider } from './llm/providers/index.ts'
export { buildProviders } from './llm/providers/factory.ts'
export { ProviderError } from './llm/providers/errors.ts'
export type { ProviderErrorKind } from './llm/providers/errors.ts'

// Prompts, ground truth, judge
export { toGroundTruth, isSparseGroundTruth } from './llm/ground-truth.ts'
export type { GroundTruth, ProbeForJudge } from './llm/ground-truth.ts'
export * from './llm/prompts.ts'
export { runJudge } from './llm/judge.ts'
export type { JudgeResult, ProbeJudgement } from './llm/judge.ts'

// Flows
export { runStaticProbe } from './llm/flows/static-probe.ts'
export type { StaticProbeResult } from './llm/flows/static-probe.ts'
export { runSelfGenProbe } from './llm/flows/self-gen.ts'
export type { SelfGenProbeResult } from './llm/flows/self-gen.ts'
export { runCoverageFlow } from './llm/flows/coverage.ts'
export type { CoverageFlowResult, CoverageProbe } from './llm/flows/coverage.ts'

// Pure scoring
export { scoreRecognition } from './scoring/recognition.ts'
export { scoreCitation } from './scoring/citation.ts'
export { scoreDiscoverability, brandFromDomain } from './scoring/discoverability.ts'
export { toLetterGrade } from './scoring/letter.ts'
export { DEFAULT_WEIGHTS } from './scoring/weights.ts'
export type { CategoryId } from './scoring/weights.ts'
export { weightedOverall } from './scoring/composite.ts'
export type { CategoryScores, OverallScore } from './scoring/composite.ts'

// Accuracy
export { runAccuracy, generateQuestion, verifyAnswer } from './accuracy/index.ts'
export type { AccuracyResult, AccuracyReason, GeneratedQuestion, VerificationResult, ProbeAnswer } from './accuracy/index.ts'
```

## 11. Testing

**~125 unit tests**, all using `MockProvider`. No real-provider calls in Plan 4. No new dev dependencies.

| Area | Test count (approx) |
|---|---|
| Providers (4 direct × ~6 tests each + ~3 mock + ~2 errors) | 25 |
| Prompts (golden-string per builder) | 15 |
| Ground truth + isSparseGroundTruth | 5 |
| Judge (parsing cascades, retry, heuristic fallback, sparse branch) | 10 |
| Flows (static-probe, self-gen, coverage) | 12 |
| Pure scoring (recognition, citation, discoverability, letter, composite, brandFromDomain) | 40 |
| Accuracy (generator, verifier, runAccuracy incl. all reason branches) | 17 |
| **Total** | **~124** |

Real-provider smoke tests are deferred to Plan 5, where the full pipeline is exercisable end-to-end and env keys can be gated behind a `REAL_PROVIDERS=1` flag in CI.

## 12. Out of scope for Plan 4

- Queue code, BullMQ jobs, worker registration
- DB writes to `probes`, `grades`, `scrapes`
- Provider-level retry or backoff (`ProviderError.kind` classifies; Plan 5 decides policy)
- Rate limiting, cost budgeting, tier logic (free vs paid)
- SSE, progress events
- Recommendation LLM (Plan 8)
- Report rendering (Plan 9)
- Real-provider integration tests
- OpenRouter routing
- Mapping Coverage's `JudgeResult.perProvider` into a single `coverage` category number — Plan 5 does this because it knows the tier's provider list

## 13. Relationship to spec §5

This sub-spec expands the master design's §5 (Scoring engine) with implementation-level detail and decisions that weren't nailed down at original spec time. Specifically:

- §5.1 category weights are unchanged; renamed `discovery` → `discoverability` to match spec table.
- §5.2 tiered provider matrix is a caller concern (Plan 5); Plan 4 takes whatever provider list it's handed.
- §5.3 accuracy flow: decisions P4-4 (per-provider verifier) and implicit from §9.3 (insufficient-scrape threshold = 500 chars).
- §5.4 SEO rubric is already implemented in Plan 3; not touched by Plan 4.

After this spec is approved, the master design's §5 should be amended with a short "Interpretation calls locked in during Plan 4 brainstorming (2026-04-17)" block pointing at this document — same pattern used for Plan 3's interpretation calls at §5.4.
