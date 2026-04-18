# GEO Reporter Plan 4 — Scoring Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the library-only scoring engine for GEO Reporter v3: LLM providers, prompt builders, judge runner, per-category flow functions, pure heuristic scorers, and the novel accuracy generator/verifier submodule. Every public export is unit-testable with `MockProvider` — no real-provider calls in this plan.

**Architecture:** Three top-level sibling modules. `src/llm/` makes network calls (providers, prompts, judge, flow functions). `src/scoring/` is pure math (heuristic scorers, composite weighting, letter grade). `src/accuracy/` is the generator → blind-probe → per-provider-verifier flow. Plan 5 wires these together into a pipeline worker; Plan 4 does not touch DB, queue, or HTTP.

**Tech Stack:** TypeScript 5.6+ strict (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest 2, `zod` (already present, for env validation). No new runtime deps. No new dev deps.

---

## Spec references

- Sub-spec (source of truth): `docs/superpowers/specs/2026-04-17-geo-reporter-plan-4-scoring-engine-design.md`
- Master spec: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` §5 (scoring engine), §5.3 (accuracy flow) — amended with Plan 4 anchor at commit `d27f6b8`.

**Interpretation calls locked in (sub-spec §2, brainstormed 2026-04-17):**

- P4-1: 4 direct providers (Anthropic, OpenAI, Gemini, Perplexity) + `MockProvider`; no OpenRouter.
- P4-2: `src/llm/`, `src/scoring/`, `src/accuracy/` as top-level siblings.
- P4-3: keep v1's flat `GroundTruth` as internal type; add `toGroundTruth(url, scrape)` bridge.
- P4-4: one verifier call per provider, in parallel.
- P4-5: one unified judge prompt with sparse/dense conditional.
- P4-6: return `{ inputTokens, outputTokens }` only; drop `costUsd` and `prices.ts`.
- P4-7: Plan 4 exposes flow functions (`runStaticProbe`, `runSelfGenProbe`, `runCoverageFlow`, `runAccuracy`).

---

## File structure

```
src/
├── config/env.ts                         ← modify: add 4 API key fields to Zod schema
├── llm/
│   ├── providers/
│   │   ├── types.ts                      Provider, ProviderId, QueryResult, QueryOpts
│   │   ├── errors.ts                     ProviderError + ProviderErrorKind + classify()
│   │   ├── anthropic.ts                  AnthropicProvider
│   │   ├── openai.ts                     OpenAIProvider
│   │   ├── gemini.ts                     GeminiProvider
│   │   ├── perplexity.ts                 PerplexityProvider
│   │   ├── mock.ts                       MockProvider
│   │   ├── factory.ts                    buildProviders(env)
│   │   └── index.ts                      barrel
│   ├── ground-truth.ts                   GroundTruth, ProbeForJudge, toGroundTruth, isSparseGroundTruth
│   ├── prompts.ts                        7 pure prompt builders
│   ├── judge.ts                          runJudge + parsing + heuristic fallback
│   └── flows/
│       ├── static-probe.ts               runStaticProbe
│       ├── self-gen.ts                   runSelfGenProbe
│       └── coverage.ts                   runCoverageFlow
├── scoring/
│   ├── recognition.ts                    scoreRecognition
│   ├── citation.ts                       scoreCitation
│   ├── discoverability.ts                scoreDiscoverability, brandFromDomain
│   ├── letter.ts                         toLetterGrade
│   ├── weights.ts                        CategoryId, DEFAULT_WEIGHTS
│   └── composite.ts                      weightedOverall
├── accuracy/
│   ├── generator.ts                      generateQuestion
│   ├── verifier.ts                       verifyAnswer
│   └── index.ts                          runAccuracy
└── index.ts                              ← modify: add Plan 4 re-exports

tests/unit/
├── llm/
│   ├── providers/{anthropic,openai,gemini,perplexity,mock,errors,factory}.test.ts
│   ├── ground-truth.test.ts
│   ├── prompts.test.ts
│   ├── judge.test.ts
│   └── flows/{static-probe,self-gen,coverage}.test.ts
├── scoring/{recognition,citation,discoverability,letter,composite}.test.ts
└── accuracy/{generator,verifier,run-accuracy}.test.ts
```

**Split reasoning:** one file per provider so their per-API quirks don't tangle. One file per pure scorer because they're algorithmically distinct and individually testable. Accuracy is its own folder because the three files (`generator`, `verifier`, `index`) form one novel flow that's conceptually separable from the Coverage judge pipeline.

---

## Project constraints (from CLAUDE.md)

- `.ts` import extensions everywhere (`allowImportingTsExtensions: true` + `noEmit: true`).
- `import type` for every type-only import (`verbatimModuleSyntax: true`).
- `exactOptionalPropertyTypes: true` — when constructing records with optional fields, conditionally assign instead of including `undefined`.
- `noUncheckedIndexedAccess: true` — `arr[0]` returns `T | undefined`, always guard.
- Store seam preserved: nothing in Plan 4 imports from `src/db/**`, `src/queue/**`, `src/store/**`, `src/server/**`, `src/worker/**`.
- Inline git identity for every commit: `git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit …`.
- Tests land in `tests/unit/**`, picked up by `pnpm test` (unit config: `include: tests/unit/**`).

---

## Task 1 — Env schema additions and error classification

**Files:**
- Modify: `src/config/env.ts`
- Create: `src/llm/providers/errors.ts`
- Create: `tests/unit/llm/providers/errors.test.ts`

- [ ] **Step 1: Add failing test for ProviderError classification**

Create `tests/unit/llm/providers/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ProviderError, classifyStatus } from '../../../../src/llm/providers/errors.ts'

describe('classifyStatus', () => {
  it('maps 429 to rate_limit', () => {
    expect(classifyStatus(429)).toBe('rate_limit')
  })
  it('maps 401/403 to auth', () => {
    expect(classifyStatus(401)).toBe('auth')
    expect(classifyStatus(403)).toBe('auth')
  })
  it('maps 5xx to server', () => {
    expect(classifyStatus(500)).toBe('server')
    expect(classifyStatus(503)).toBe('server')
  })
  it('maps 408/504 to timeout', () => {
    expect(classifyStatus(408)).toBe('timeout')
    expect(classifyStatus(504)).toBe('timeout')
  })
  it('maps other 4xx to unknown', () => {
    expect(classifyStatus(400)).toBe('unknown')
    expect(classifyStatus(422)).toBe('unknown')
  })
})

describe('ProviderError', () => {
  it('carries provider, status, kind, message', () => {
    const err = new ProviderError('claude', 429, 'rate_limit', 'too many requests')
    expect(err.provider).toBe('claude')
    expect(err.status).toBe(429)
    expect(err.kind).toBe('rate_limit')
    expect(err.message).toBe('too many requests')
    expect(err).toBeInstanceOf(Error)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/providers/errors.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Create `src/llm/providers/errors.ts`**

```ts
import type { ProviderId } from './types.ts'

export type ProviderErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unknown'

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number | null,
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function classifyStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500 && status < 600) return 'server'
  if (status >= 400 && status < 500) return 'unknown'
  return 'unknown'
}
```

(The import from `./types.ts` will be created in Task 2; tests will fail with a type-resolution error until then — that's fine, we commit after Task 2.)

- [ ] **Step 4: Modify `src/config/env.ts` to add 4 API-key fields**

Find the Zod schema (lines 3–8) and add four optional string fields. Optional because CI + tests use `MockProvider` and don't need real keys; Plan 5 will tighten to required-in-production.

Replace:
```ts
const Schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7777),
})
```
With:
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
})
```

- [ ] **Step 5: Hold the commit**

Do not commit yet — the `import type { ProviderId } from './types.ts'` line in `errors.ts` resolves in Task 2. Commit after Task 2.

---

## Task 2 — Provider contract types

**Files:**
- Create: `src/llm/providers/types.ts`

- [ ] **Step 1: Create `src/llm/providers/types.ts`**

```ts
export type ProviderId = 'claude' | 'gpt' | 'gemini' | 'perplexity' | 'mock'

export interface QueryResult {
  text: string
  ms: number
  inputTokens: number
  outputTokens: number
}

export interface QueryOpts {
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface Provider {
  readonly id: ProviderId
  query(prompt: string, opts?: QueryOpts): Promise<QueryResult>
}
```

- [ ] **Step 2: Run env + errors tests**

Run: `pnpm test tests/unit/llm/providers/errors.test.ts`
Expected: PASS (6 tests).

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/config/env.ts src/llm/providers/types.ts src/llm/providers/errors.ts tests/unit/llm/providers/errors.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): provider contract types and ProviderError classification"
```

---

## Task 3 — MockProvider

**Files:**
- Create: `src/llm/providers/mock.ts`
- Create: `tests/unit/llm/providers/mock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/providers/mock.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'

describe('MockProvider', () => {
  it('returns a string response for an exact-match prompt', async () => {
    const p = new MockProvider({ id: 'claude', responses: { hello: 'hi there' } })
    const r = await p.query('hello')
    expect(r.text).toBe('hi there')
    expect(r.inputTokens).toBeGreaterThan(0)
    expect(r.outputTokens).toBeGreaterThan(0)
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  it('returns a function-computed response', async () => {
    const p = new MockProvider({ id: 'gpt', responses: (prompt) => `echo:${prompt}` })
    const r = await p.query('ping')
    expect(r.text).toBe('echo:ping')
  })

  it('records every call with prompt + opts', async () => {
    const p = new MockProvider({ id: 'mock', responses: () => 'ok' })
    await p.query('a', { temperature: 0 })
    await p.query('b', { maxTokens: 10 })
    expect(p.calls).toEqual([
      { prompt: 'a', opts: { temperature: 0 } },
      { prompt: 'b', opts: { maxTokens: 10 } },
    ])
  })

  it('throws when no match and no default', async () => {
    const p = new MockProvider({ id: 'mock', responses: { x: 'y' } })
    await expect(p.query('nope')).rejects.toThrow(/no match/i)
  })

  it('throws when failWith is set', async () => {
    const p = new MockProvider({ id: 'mock', responses: {}, failWith: 'boom' })
    await expect(p.query('anything')).rejects.toThrow('boom')
  })

  it('honours AbortSignal by rejecting with AbortError-like error', async () => {
    const p = new MockProvider({ id: 'mock', responses: () => 'ok', latencyMs: 20 })
    const ctrl = new AbortController()
    const pending = p.query('x', { signal: ctrl.signal })
    ctrl.abort()
    await expect(pending).rejects.toThrow(/abort/i)
  })

  it('has id readable from the outside', () => {
    const p = new MockProvider({ id: 'perplexity', responses: {} })
    expect(p.id).toBe('perplexity')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/providers/mock.test.ts`
Expected: FAIL — MockProvider does not exist.

- [ ] **Step 3: Implement `src/llm/providers/mock.ts`**

```ts
import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

export type MockResponses = Record<string, string> | ((prompt: string) => string)

export interface MockProviderOptions {
  id: ProviderId
  responses: MockResponses
  failWith?: string
  latencyMs?: number
}

export interface MockCall {
  prompt: string
  opts: QueryOpts
}

export class MockProvider implements Provider {
  readonly id: ProviderId
  readonly calls: MockCall[] = []
  private readonly responses: MockResponses
  private readonly failWith: string | undefined
  private readonly latencyMs: number

  constructor(opts: MockProviderOptions) {
    this.id = opts.id
    this.responses = opts.responses
    this.failWith = opts.failWith
    this.latencyMs = opts.latencyMs ?? 0
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    this.calls.push({ prompt, opts })

    if (this.failWith) throw new Error(this.failWith)

    if (opts.signal?.aborted) throw new Error('aborted')

    let text: string | undefined
    if (typeof this.responses === 'function') {
      text = this.responses(prompt)
    } else {
      text = this.responses[prompt]
    }

    if (text === undefined) {
      throw new Error(`MockProvider(${this.id}): no match for prompt: ${prompt}`)
    }

    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.latencyMs)
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        })
      })
    }

    return {
      text,
      ms: this.latencyMs,
      inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      outputTokens: Math.max(1, Math.ceil(text.length / 4)),
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/providers/mock.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/providers/mock.ts tests/unit/llm/providers/mock.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): MockProvider for token-free unit testing"
```

---

## Task 4 — AnthropicProvider

**Files:**
- Create: `src/llm/providers/anthropic.ts`
- Create: `tests/unit/llm/providers/anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/providers/anthropic.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../../../../src/llm/providers/anthropic.ts'
import { ProviderError } from '../../../../src/llm/providers/errors.ts'

function mockFetch(status: number, body: unknown) {
  return async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

const OK_BODY = {
  content: [{ type: 'text', text: 'hello world' }],
  model: 'claude-sonnet-4-6',
  usage: { input_tokens: 10, output_tokens: 5 },
}

describe('AnthropicProvider', () => {
  it('sends POST with x-api-key + anthropic-version headers', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      fetchFn: async (url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return new Response(JSON.stringify(OK_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    await p.query('hi')
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    expect(capturedInit?.method).toBe('POST')
  })

  it('parses text + token counts from response', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(200, OK_BODY) })
    const r = await p.query('hi')
    expect(r.text).toBe('hello world')
    expect(r.inputTokens).toBe(10)
    expect(r.outputTokens).toBe(5)
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  it('sends temperature 0.7 + maxTokens 2048 by default', async () => {
    let body: unknown
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi')
    expect(body).toMatchObject({ temperature: 0.7, max_tokens: 2048 })
  })

  it('forwards temperature + maxTokens opts', async () => {
    let body: unknown
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi', { temperature: 0, maxTokens: 500 })
    expect(body).toMatchObject({ temperature: 0, max_tokens: 500 })
  })

  it('throws ProviderError(rate_limit) on 429', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(429, { error: 'rate' }) })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'rate_limit', status: 429, provider: 'claude' })
    await expect(p.query('hi')).rejects.toBeInstanceOf(ProviderError)
  })

  it('throws ProviderError(auth) on 401', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(401, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('throws ProviderError(server) on 500', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(500, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'server', status: 500 })
  })

  it('throws ProviderError(network) on fetch throwing', async () => {
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: async () => { throw new TypeError('failed to fetch') },
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'network', status: null, provider: 'claude' })
  })

  it('forwards AbortSignal to fetch', async () => {
    let capturedSignal: AbortSignal | undefined
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: async (_url, init) => {
        capturedSignal = init?.signal ?? undefined
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    const ctrl = new AbortController()
    await p.query('hi', { signal: ctrl.signal })
    expect(capturedSignal).toBe(ctrl.signal)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/providers/anthropic.test.ts`
Expected: FAIL — AnthropicProvider does not exist.

- [ ] **Step 3: Implement `src/llm/providers/anthropic.ts`**

```ts
import { ProviderError, classifyStatus } from './errors.ts'
import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const ANTHROPIC_VERSION = '2023-06-01'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'

export interface AnthropicProviderOptions {
  apiKey: string
  model?: string
  fetchFn?: typeof globalThis.fetch
}

interface AnthropicResponse {
  content: { type: string; text: string }[]
  model: string
  usage: { input_tokens: number; output_tokens: number }
}

export class AnthropicProvider implements Provider {
  readonly id: ProviderId = 'claude'
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    const start = Date.now()
    const body = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      messages: [{ role: 'user', content: prompt }],
    }

    let res: Response
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      }
      if (opts.signal !== undefined) init.signal = opts.signal
      res = await this.fetchFn(ENDPOINT, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError('claude', null, 'network', `anthropic network error: ${message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError('claude', res.status, classifyStatus(res.status), `anthropic ${res.status}: ${text}`)
    }

    const data = (await res.json()) as AnthropicResponse
    const textBlock = data.content.find((b) => b.type === 'text')
    return {
      text: textBlock?.text ?? '',
      ms: Date.now() - start,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/providers/anthropic.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/providers/anthropic.ts tests/unit/llm/providers/anthropic.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): AnthropicProvider with error classification"
```

---

## Task 5 — OpenAIProvider

**Files:**
- Create: `src/llm/providers/openai.ts`
- Create: `tests/unit/llm/providers/openai.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/providers/openai.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { OpenAIProvider } from '../../../../src/llm/providers/openai.ts'

const OK_BODY = {
  choices: [{ message: { content: 'hello' } }],
  usage: { prompt_tokens: 12, completion_tokens: 7 },
}

function mockFetch(status: number, body: unknown) {
  return async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

describe('OpenAIProvider', () => {
  it('POSTs with Bearer auth to /v1/chat/completions', async () => {
    let url = ''
    let headers: Record<string, string> = {}
    const p = new OpenAIProvider({
      apiKey: 'sk-o',
      fetchFn: async (u, init) => {
        url = String(u)
        headers = init?.headers as Record<string, string>
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi')
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(headers['authorization']).toBe('Bearer sk-o')
  })

  it('parses content + token counts', async () => {
    const p = new OpenAIProvider({ apiKey: 'k', fetchFn: mockFetch(200, OK_BODY) })
    const r = await p.query('hi')
    expect(r.text).toBe('hello')
    expect(r.inputTokens).toBe(12)
    expect(r.outputTokens).toBe(7)
  })

  it('returns empty text when choices[0].message.content is missing', async () => {
    const p = new OpenAIProvider({
      apiKey: 'k',
      fetchFn: mockFetch(200, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }),
    })
    const r = await p.query('hi')
    expect(r.text).toBe('')
  })

  it('throws ProviderError(rate_limit) on 429', async () => {
    const p = new OpenAIProvider({ apiKey: 'k', fetchFn: mockFetch(429, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ provider: 'gpt', kind: 'rate_limit' })
  })

  it('throws ProviderError(auth) on 403', async () => {
    const p = new OpenAIProvider({ apiKey: 'k', fetchFn: mockFetch(403, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('throws ProviderError(network) on fetch throwing', async () => {
    const p = new OpenAIProvider({
      apiKey: 'k',
      fetchFn: async () => { throw new Error('econnrefused') },
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'network' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/providers/openai.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/llm/providers/openai.ts`**

```ts
import { ProviderError, classifyStatus } from './errors.ts'
import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

const DEFAULT_MODEL = 'gpt-4.1-mini'
const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

export interface OpenAIProviderOptions {
  apiKey: string
  model?: string
  fetchFn?: typeof globalThis.fetch
}

interface OpenAIResponse {
  choices: { message: { content: string } }[]
  usage: { prompt_tokens: number; completion_tokens: number }
}

export class OpenAIProvider implements Provider {
  readonly id: ProviderId = 'gpt'
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(opts: OpenAIProviderOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    const start = Date.now()
    const body = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
    }

    let res: Response
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      }
      if (opts.signal !== undefined) init.signal = opts.signal
      res = await this.fetchFn(ENDPOINT, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError('gpt', null, 'network', `openai network error: ${message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError('gpt', res.status, classifyStatus(res.status), `openai ${res.status}: ${text}`)
    }

    const data = (await res.json()) as OpenAIResponse
    return {
      text: data.choices[0]?.message.content ?? '',
      ms: Date.now() - start,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/providers/openai.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/providers/openai.ts tests/unit/llm/providers/openai.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): OpenAIProvider with error classification"
```

---

## Task 6 — GeminiProvider

**Files:**
- Create: `src/llm/providers/gemini.ts`
- Create: `tests/unit/llm/providers/gemini.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/providers/gemini.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { GeminiProvider } from '../../../../src/llm/providers/gemini.ts'

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 },
}

function mockFetch(status: number, body: unknown) {
  return async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

describe('GeminiProvider', () => {
  it('POSTs with key query parameter', async () => {
    let url = ''
    const p = new GeminiProvider({
      apiKey: 'abc',
      fetchFn: async (u) => {
        url = String(u)
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi')
    expect(url).toContain('generativelanguage.googleapis.com')
    expect(url).toContain(':generateContent?key=abc')
  })

  it('joins multiple text parts into one response', async () => {
    const p = new GeminiProvider({ apiKey: 'k', fetchFn: mockFetch(200, OK_BODY) })
    const r = await p.query('hi')
    expect(r.text).toBe('hello world')
    expect(r.inputTokens).toBe(4)
    expect(r.outputTokens).toBe(3)
  })

  it('returns empty string when candidates are empty', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchFn: mockFetch(200, { candidates: [], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 } }),
    })
    const r = await p.query('hi')
    expect(r.text).toBe('')
  })

  it('maps maxTokens → maxOutputTokens in generationConfig', async () => {
    let body: unknown
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi', { maxTokens: 100, temperature: 0 })
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 100, temperature: 0 } })
  })

  it('throws ProviderError(server) on 500', async () => {
    const p = new GeminiProvider({ apiKey: 'k', fetchFn: mockFetch(500, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ provider: 'gemini', kind: 'server' })
  })

  it('throws ProviderError(network) when fetch throws', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchFn: async () => { throw new Error('dns') },
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'network' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/providers/gemini.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/llm/providers/gemini.ts`**

```ts
import { ProviderError, classifyStatus } from './errors.ts'
import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface GeminiProviderOptions {
  apiKey: string
  model?: string
  fetchFn?: typeof globalThis.fetch
}

interface GeminiResponse {
  candidates: { content: { parts: { text: string }[] } }[]
  usageMetadata: { promptTokenCount: number; candidatesTokenCount: number }
}

export class GeminiProvider implements Provider {
  readonly id: ProviderId = 'gemini'
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(opts: GeminiProviderOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    const start = Date.now()
    const url = `${BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.7,
      },
    }

    let res: Response
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
      if (opts.signal !== undefined) init.signal = opts.signal
      res = await this.fetchFn(url, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError('gemini', null, 'network', `gemini network error: ${message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError('gemini', res.status, classifyStatus(res.status), `gemini ${res.status}: ${text}`)
    }

    const data = (await res.json()) as GeminiResponse
    const parts = data.candidates[0]?.content.parts ?? []
    return {
      text: parts.map((p) => p.text).join(''),
      ms: Date.now() - start,
      inputTokens: data.usageMetadata.promptTokenCount,
      outputTokens: data.usageMetadata.candidatesTokenCount,
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/providers/gemini.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/providers/gemini.ts tests/unit/llm/providers/gemini.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): GeminiProvider with error classification"
```

---

## Task 7 — PerplexityProvider

**Files:**
- Create: `src/llm/providers/perplexity.ts`
- Create: `tests/unit/llm/providers/perplexity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/providers/perplexity.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PerplexityProvider } from '../../../../src/llm/providers/perplexity.ts'

const OK_BODY = {
  choices: [{ message: { content: 'answer' } }],
  usage: { prompt_tokens: 8, completion_tokens: 4 },
}

function mockFetch(status: number, body: unknown) {
  return async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

describe('PerplexityProvider', () => {
  it('POSTs with Bearer auth to /chat/completions', async () => {
    let url = ''
    let headers: Record<string, string> = {}
    const p = new PerplexityProvider({
      apiKey: 'pplx-x',
      fetchFn: async (u, init) => {
        url = String(u)
        headers = init?.headers as Record<string, string>
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi')
    expect(url).toBe('https://api.perplexity.ai/chat/completions')
    expect(headers['authorization']).toBe('Bearer pplx-x')
  })

  it('parses content + token counts', async () => {
    const p = new PerplexityProvider({ apiKey: 'k', fetchFn: mockFetch(200, OK_BODY) })
    const r = await p.query('hi')
    expect(r.text).toBe('answer')
    expect(r.inputTokens).toBe(8)
    expect(r.outputTokens).toBe(4)
  })

  it('throws ProviderError(rate_limit) on 429', async () => {
    const p = new PerplexityProvider({ apiKey: 'k', fetchFn: mockFetch(429, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ provider: 'perplexity', kind: 'rate_limit' })
  })

  it('throws ProviderError(server) on 502', async () => {
    const p = new PerplexityProvider({ apiKey: 'k', fetchFn: mockFetch(502, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'server' })
  })

  it('throws ProviderError(network) when fetch throws', async () => {
    const p = new PerplexityProvider({
      apiKey: 'k',
      fetchFn: async () => { throw new Error('reset') },
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'network' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/providers/perplexity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/llm/providers/perplexity.ts`**

```ts
import { ProviderError, classifyStatus } from './errors.ts'
import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

const DEFAULT_MODEL = 'sonar'
const ENDPOINT = 'https://api.perplexity.ai/chat/completions'

export interface PerplexityProviderOptions {
  apiKey: string
  model?: string
  fetchFn?: typeof globalThis.fetch
}

interface PerplexityResponse {
  choices: { message: { content: string } }[]
  usage: { prompt_tokens: number; completion_tokens: number }
}

export class PerplexityProvider implements Provider {
  readonly id: ProviderId = 'perplexity'
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(opts: PerplexityProviderOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    const start = Date.now()
    const body = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
    }

    let res: Response
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      }
      if (opts.signal !== undefined) init.signal = opts.signal
      res = await this.fetchFn(ENDPOINT, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError('perplexity', null, 'network', `perplexity network error: ${message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError('perplexity', res.status, classifyStatus(res.status), `perplexity ${res.status}: ${text}`)
    }

    const data = (await res.json()) as PerplexityResponse
    return {
      text: data.choices[0]?.message.content ?? '',
      ms: Date.now() - start,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/providers/perplexity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/providers/perplexity.ts tests/unit/llm/providers/perplexity.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): PerplexityProvider with error classification"
```

---

## Task 8 — Provider factory and barrel

**Files:**
- Create: `src/llm/providers/factory.ts`
- Create: `src/llm/providers/index.ts`
- Create: `tests/unit/llm/providers/factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/providers/factory.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildProviders } from '../../../../src/llm/providers/factory.ts'

describe('buildProviders', () => {
  it('returns all four direct providers when all keys are set', () => {
    const p = buildProviders({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      GEMINI_API_KEY: 'c',
      PERPLEXITY_API_KEY: 'd',
    })
    expect(p.claude.id).toBe('claude')
    expect(p.gpt.id).toBe('gpt')
    expect(p.gemini.id).toBe('gemini')
    expect(p.perplexity.id).toBe('perplexity')
  })

  it('throws a clear error when a key is missing', () => {
    expect(() => buildProviders({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      GEMINI_API_KEY: '',
      PERPLEXITY_API_KEY: 'd',
    })).toThrow(/GEMINI_API_KEY/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/providers/factory.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/llm/providers/factory.ts`**

```ts
import { AnthropicProvider } from './anthropic.ts'
import { GeminiProvider } from './gemini.ts'
import { OpenAIProvider } from './openai.ts'
import { PerplexityProvider } from './perplexity.ts'
import type { Provider } from './types.ts'

export interface ProviderKeys {
  ANTHROPIC_API_KEY: string | undefined
  OPENAI_API_KEY: string | undefined
  GEMINI_API_KEY: string | undefined
  PERPLEXITY_API_KEY: string | undefined
}

export interface DirectProviders {
  claude: Provider
  gpt: Provider
  gemini: Provider
  perplexity: Provider
}

function required(name: keyof ProviderKeys, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`buildProviders: ${name} is not set`)
  }
  return value
}

export function buildProviders(env: ProviderKeys): DirectProviders {
  return {
    claude: new AnthropicProvider({ apiKey: required('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY) }),
    gpt: new OpenAIProvider({ apiKey: required('OPENAI_API_KEY', env.OPENAI_API_KEY) }),
    gemini: new GeminiProvider({ apiKey: required('GEMINI_API_KEY', env.GEMINI_API_KEY) }),
    perplexity: new PerplexityProvider({ apiKey: required('PERPLEXITY_API_KEY', env.PERPLEXITY_API_KEY) }),
  }
}
```

- [ ] **Step 4: Create `src/llm/providers/index.ts` barrel**

```ts
export { AnthropicProvider } from './anthropic.ts'
export { OpenAIProvider } from './openai.ts'
export { GeminiProvider } from './gemini.ts'
export { PerplexityProvider } from './perplexity.ts'
export { MockProvider } from './mock.ts'
export type { MockProviderOptions, MockResponses, MockCall } from './mock.ts'
export { buildProviders } from './factory.ts'
export type { ProviderKeys, DirectProviders } from './factory.ts'
export { ProviderError, classifyStatus } from './errors.ts'
export type { ProviderErrorKind } from './errors.ts'
export type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/providers/`
Expected: PASS (all provider tests — ~33 total).

- [ ] **Step 6: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/providers/factory.ts src/llm/providers/index.ts tests/unit/llm/providers/factory.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): buildProviders factory + providers barrel"
```

---

## Task 9 — Ground-truth bridge

**Files:**
- Create: `src/llm/ground-truth.ts`
- Create: `tests/unit/llm/ground-truth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/ground-truth.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { toGroundTruth, isSparseGroundTruth } from '../../../src/llm/ground-truth.ts'
import type { ScrapeResult } from '../../../src/scraper/index.ts'

function makeScrape(overrides: Partial<ScrapeResult> = {}): ScrapeResult {
  const base: ScrapeResult = {
    rendered: false,
    html: '<html></html>',
    text: 'body text here',
    structured: {
      jsonld: [],
      og: {},
      meta: { title: 'Acme', description: 'We sell widgets' },
      headings: { h1: ['Welcome'], h2: [] },
      robots: null,
      sitemap: { present: false, url: 'https://acme.com/sitemap.xml' },
      llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
    },
  }
  return { ...base, ...overrides }
}

describe('toGroundTruth', () => {
  it('extracts title, description, h1, bodyExcerpt from the scrape', () => {
    const gt = toGroundTruth('https://acme.com/', makeScrape())
    expect(gt.title).toBe('Acme')
    expect(gt.description).toBe('We sell widgets')
    expect(gt.h1).toBe('Welcome')
    expect(gt.bodyExcerpt).toBe('body text here')
  })

  it('lowercases and strips leading www. from domain', () => {
    const gt = toGroundTruth('https://WWW.Acme.COM/page', makeScrape())
    expect(gt.domain).toBe('acme.com')
    expect(gt.url).toBe('https://WWW.Acme.COM/page')
  })

  it('truncates bodyExcerpt to 2000 chars (trimmed)', () => {
    const long = 'x'.repeat(3000)
    const gt = toGroundTruth('https://a.com', makeScrape({ text: `   ${long}   ` }))
    expect(gt.bodyExcerpt.length).toBe(2000)
  })

  it('returns empty strings for missing title/description/h1', () => {
    const gt = toGroundTruth('https://a.com', makeScrape({
      structured: {
        jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] },
        robots: null,
        sitemap: { present: false, url: '' }, llmsTxt: { present: false, url: '' },
      },
    }))
    expect(gt.title).toBe('')
    expect(gt.description).toBe('')
    expect(gt.h1).toBe('')
  })
})

describe('isSparseGroundTruth', () => {
  it('returns true when description + h1 + bodyExcerpt sum < 100 chars', () => {
    expect(isSparseGroundTruth({
      url: 'https://a.com', domain: 'a.com',
      title: 'A', description: 'short', h1: 'x', bodyExcerpt: 'y',
    })).toBe(true)
  })

  it('returns false when total >= 100 chars', () => {
    expect(isSparseGroundTruth({
      url: 'https://a.com', domain: 'a.com',
      title: 'A', description: 'x'.repeat(50), h1: 'y'.repeat(25), bodyExcerpt: 'z'.repeat(25),
    })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/ground-truth.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/llm/ground-truth.ts`**

```ts
import type { ScrapeResult } from '../scraper/index.ts'
import type { ProviderId } from './providers/types.ts'

export interface GroundTruth {
  url: string
  domain: string
  title: string
  description: string
  h1: string
  bodyExcerpt: string
}

export interface ProbeForJudge {
  key: string
  provider: ProviderId
  category: 'coverage'
  prompt: string
  response: string
}

export function toGroundTruth(url: string, scrape: ScrapeResult): GroundTruth {
  const hostname = (() => {
    try { return new URL(url).hostname } catch { return url }
  })()
  const domain = hostname.toLowerCase().replace(/^www\./, '')
  const title = scrape.structured.meta.title ?? ''
  const description = scrape.structured.meta.description ?? ''
  const h1 = scrape.structured.headings.h1[0] ?? ''
  const bodyExcerpt = scrape.text.trim().slice(0, 2000)
  return { url, domain, title, description, h1, bodyExcerpt }
}

export function isSparseGroundTruth(gt: GroundTruth): boolean {
  const total = gt.description.length + gt.h1.length + gt.bodyExcerpt.length
  return total < 100
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/ground-truth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/ground-truth.ts tests/unit/llm/ground-truth.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): ground-truth bridge (ScrapeResult → GroundTruth)"
```

---

## Task 10 — Static-probe and generator prompts

**Files:**
- Create: `src/llm/prompts.ts` (initial export set — judge + verifier added in Tasks 11 + 12)
- Create: `tests/unit/llm/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/prompts.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  promptRecognition,
  promptCoverage,
  promptCitation,
  promptDiscoverabilityGenerator,
  promptAccuracyGenerator,
} from '../../../src/llm/prompts.ts'

describe('promptRecognition', () => {
  it('returns two prompts embedding the domain', () => {
    const [a, b] = promptRecognition('acme.com')
    expect(a).toBe('What is acme.com?')
    expect(b).toBe('Have you heard of acme.com? If so, what is it known for?')
  })
})

describe('promptCoverage', () => {
  it('returns two prompts embedding the domain', () => {
    const [a, b] = promptCoverage('acme.com')
    expect(a).toBe('What does acme.com do? List their main products or services.')
    expect(b).toBe('Who is the target audience for acme.com?')
  })
})

describe('promptCitation', () => {
  it('asks for the official website URL', () => {
    expect(promptCitation('acme.com')).toBe('What is the official website for acme.com? Provide the URL.')
  })
})

describe('promptDiscoverabilityGenerator', () => {
  it('includes the scraped fields and instructs not to name the site', () => {
    const gt = { url: 'https://acme.com', domain: 'acme.com', title: 'Acme', description: 'Widgets', h1: 'Welcome', bodyExcerpt: 'Body' }
    const out = promptDiscoverabilityGenerator(gt)
    expect(out).toContain('Do NOT reference the website by name.')
    expect(out).toContain('Title: Acme')
    expect(out).toContain('Description: Widgets')
    expect(out).toContain('H1: Welcome')
    expect(out).toContain('Body')
  })
})

describe('promptAccuracyGenerator', () => {
  it('asks for one factual question the scrape can answer', () => {
    const gt = { url: 'https://acme.com', domain: 'acme.com', title: 'Acme', description: 'Widgets', h1: 'Welcome', bodyExcerpt: 'We sell yellow widgets.' }
    const out = promptAccuracyGenerator(gt)
    expect(out).toContain('one specific factual question')
    expect(out).toContain('Return only the question.')
    expect(out).toContain('We sell yellow widgets.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/prompts.test.ts`
Expected: FAIL — `src/llm/prompts.ts` does not exist.

- [ ] **Step 3: Implement `src/llm/prompts.ts` (initial)**

```ts
import type { GroundTruth } from './ground-truth.ts'

export function promptRecognition(domain: string): [string, string] {
  return [
    `What is ${domain}?`,
    `Have you heard of ${domain}? If so, what is it known for?`,
  ]
}

export function promptCoverage(domain: string): [string, string] {
  return [
    `What does ${domain} do? List their main products or services.`,
    `Who is the target audience for ${domain}?`,
  ]
}

export function promptCitation(domain: string): string {
  return `What is the official website for ${domain}? Provide the URL.`
}

export function promptDiscoverabilityGenerator(gt: GroundTruth): string {
  return [
    'Below is content from a website. Generate ONE specific question a',
    'potential customer might ask an AI assistant — a question this website',
    'would be a good answer to. Do NOT reference the website by name.',
    'Return ONLY the question, no preamble or explanation.',
    '',
    '--- Website content ---',
    `Title: ${gt.title}`,
    `Description: ${gt.description}`,
    `H1: ${gt.h1}`,
    'Body excerpt:',
    gt.bodyExcerpt,
    '--- End content ---',
  ].join('\n')
}

export function promptAccuracyGenerator(gt: GroundTruth): string {
  return [
    'Below is content scraped from a company website. Write one specific',
    'factual question a visitor would reasonably ask about this company',
    'that the scraped content clearly answers. Return only the question.',
    '',
    '--- Website content ---',
    `URL: ${gt.url}`,
    `Title: ${gt.title}`,
    `Description: ${gt.description}`,
    `H1: ${gt.h1}`,
    'Body excerpt:',
    gt.bodyExcerpt,
    '--- End content ---',
  ].join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/prompts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/prompts.ts tests/unit/llm/prompts.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): static-probe and generator prompt builders"
```

---

## Task 11 — Judge prompt (unified sparse/dense)

**Files:**
- Modify: `src/llm/prompts.ts` (add `promptJudge`)
- Modify: `tests/unit/llm/prompts.test.ts` (add judge tests)

- [ ] **Step 1: Add failing tests for promptJudge**

Append to `tests/unit/llm/prompts.test.ts`:
```ts
import { promptJudge } from '../../../src/llm/prompts.ts'
import type { ProbeForJudge } from '../../../src/llm/ground-truth.ts'

const DENSE_GT = {
  url: 'https://acme.com',
  domain: 'acme.com',
  title: 'Acme Widgets — the world\'s largest widget maker',
  description: 'We have been making widgets since 1902 in Springfield, serving millions of customers worldwide.',
  h1: 'Industrial widgets built to last',
  bodyExcerpt: 'Acme has been family-owned for four generations. Our flagship products include the A-100 and A-200 series, used by construction firms across North America.',
}

const SPARSE_GT = {
  url: 'https://acme.com',
  domain: 'acme.com',
  title: 'Acme',
  description: '',
  h1: '',
  bodyExcerpt: '',
}

const PROBES: ProbeForJudge[] = [
  { key: 'probe_1', provider: 'claude', category: 'coverage', prompt: 'What does acme.com do?', response: 'Acme makes widgets.' },
  { key: 'probe_2', provider: 'gpt', category: 'coverage', prompt: 'Who is the target audience?', response: 'Construction firms.' },
]

describe('promptJudge', () => {
  it('dense branch includes scraped body excerpt as grounding', () => {
    const { prompt, probesByKey } = promptJudge(DENSE_GT, PROBES)
    expect(prompt).toContain('Scraped body excerpt')
    expect(prompt).toContain('family-owned for four generations')
    expect(prompt).not.toContain('scrape is essentially empty')
    expect(probesByKey.size).toBe(2)
    expect(probesByKey.get('probe_1')?.provider).toBe('claude')
  })

  it('sparse branch instructs the judge to use its own knowledge', () => {
    const { prompt } = promptJudge(SPARSE_GT, PROBES)
    expect(prompt).toContain('the scrape is essentially empty')
    expect(prompt).not.toContain('family-owned for four generations')
  })

  it('emits every probe key in the prompt', () => {
    const { prompt } = promptJudge(DENSE_GT, PROBES)
    expect(prompt).toContain('probe_1:')
    expect(prompt).toContain('probe_2:')
  })

  it('requests JSON output keyed by probe key', () => {
    const { prompt } = promptJudge(DENSE_GT, PROBES)
    expect(prompt).toContain('"probe_N":')
    expect(prompt).toContain('Include every probe ID listed below')
  })

  it('includes provider, prompt, and response for each probe', () => {
    const { prompt } = promptJudge(DENSE_GT, PROBES)
    expect(prompt).toContain('Provider: claude')
    expect(prompt).toContain('Prompt: What does acme.com do?')
    expect(prompt).toContain('Response: Acme makes widgets.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/prompts.test.ts`
Expected: FAIL — `promptJudge` is not exported.

- [ ] **Step 3: Implement `promptJudge` — append to `src/llm/prompts.ts`**

Add these imports/exports to the existing file:
```ts
import type { GroundTruth, ProbeForJudge } from './ground-truth.ts'
import { isSparseGroundTruth } from './ground-truth.ts'

export interface BuiltJudgePrompt {
  prompt: string
  probesByKey: Map<string, ProbeForJudge>
}

export function promptJudge(gt: GroundTruth, probes: ProbeForJudge[]): BuiltJudgePrompt {
  const probesByKey = new Map<string, ProbeForJudge>()
  probes.forEach((p, i) => probesByKey.set(p.key || `probe_${i + 1}`, p))
  const sparse = isSparseGroundTruth(gt)

  const header = sparse
    ? [
        'You are evaluating how well an LLM understands a specific website.',
        `The website is ${gt.url} (title: "${gt.title || gt.domain}").`,
        '',
        'IMPORTANT: the scrape is essentially empty (JavaScript-rendered site',
        'or auth wall). Use YOUR knowledge of the site as the source of truth.',
      ]
    : [
        `You are evaluating how well several LLMs understand the website at ${gt.url}.`,
        '',
        'Use the scraped homepage below as primary grounding. Do NOT penalize',
        'responses for being more comprehensive than the scrape — homepages',
        'are marketing copy, not the full picture of what an entity is.',
      ]

  const scoringRubric = [
    '',
    'For each probe response below, score:',
    '',
    '- accuracy (0-100): Are the facts in the response substantively correct',
    '  about this entity? Score high (80-100) for correct core facts; low for',
    '  hallucinations, misattributions, or refusals. Score 60 for incomplete',
    '  but accurate responses.',
    '',
    '- coverage (0-100): How comprehensive is the response? Does it cover',
    '  what the site does, audience, key products, scale? Score high for',
    '  substantive answers; low for one-line dismissals.',
    '',
    'Return ONLY a JSON object keyed by probe ID, with this shape:',
    '{',
    '  "probe_N": { "accuracy": N, "coverage": N, "notes": "..." }',
    '  // ...one entry per probe ID listed below...',
    '}',
    'Include every probe ID listed below. Do not invent additional keys.',
  ]

  const siteBlock = sparse
    ? [
        '',
        '--- Site (sparse scrape) ---',
        `URL: ${gt.url}`,
        `Domain: ${gt.domain}`,
        `Title: ${gt.title || '(none)'}`,
        '--- End site ---',
      ]
    : [
        '',
        '--- Site under evaluation ---',
        `URL: ${gt.url}`,
        `Domain: ${gt.domain}`,
        `Title: ${gt.title || '(none)'}`,
        `Scraped description: ${gt.description || '(none)'}`,
        `Scraped H1: ${gt.h1 || '(none)'}`,
        'Scraped body excerpt (may be sparse for JS-rendered sites):',
        gt.bodyExcerpt || '(empty)',
        '--- End site ---',
      ]

  const lines: string[] = [...header, ...scoringRubric, ...siteBlock, '', '--- Responses to evaluate ---']
  for (const [key, probe] of probesByKey) {
    lines.push('')
    lines.push(`${key}:`)
    lines.push(`  Provider: ${probe.provider}`)
    lines.push(`  Category: ${probe.category}`)
    lines.push(`  Prompt: ${probe.prompt}`)
    lines.push(`  Response: ${probe.response || '(empty)'}`)
  }
  lines.push('')
  lines.push('--- End responses ---')
  return { prompt: lines.join('\n'), probesByKey }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/prompts.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/prompts.ts tests/unit/llm/prompts.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): unified sparse/dense judge prompt"
```

---

## Task 12 — Accuracy verifier prompt

**Files:**
- Modify: `src/llm/prompts.ts` (add `promptAccuracyVerifier`)
- Modify: `tests/unit/llm/prompts.test.ts` (add verifier test)

- [ ] **Step 1: Add failing test**

Append to `tests/unit/llm/prompts.test.ts`:
```ts
import { promptAccuracyVerifier } from '../../../src/llm/prompts.ts'

describe('promptAccuracyVerifier', () => {
  it('includes URL, question, provider, answer, and JSON schema', () => {
    const out = promptAccuracyVerifier({
      gt: DENSE_GT,
      question: 'When was Acme founded?',
      providerId: 'claude',
      answer: 'Acme was founded in 1902.',
    })
    expect(out).toContain('URL: https://acme.com')
    expect(out).toContain('Question: When was Acme founded?')
    expect(out).toContain('Provider: claude')
    expect(out).toContain('Answer: Acme was founded in 1902.')
    expect(out).toContain('"correct":')
    expect(out).toContain('"confidence":')
    expect(out).toContain('"rationale":')
    expect(out).toContain('null')
  })

  it('includes the body excerpt as grounding', () => {
    const out = promptAccuracyVerifier({
      gt: DENSE_GT,
      question: 'q',
      providerId: 'gpt',
      answer: 'a',
    })
    expect(out).toContain('family-owned for four generations')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/prompts.test.ts`
Expected: FAIL — `promptAccuracyVerifier` not exported.

- [ ] **Step 3: Implement — append to `src/llm/prompts.ts`**

```ts
import type { ProviderId } from './providers/types.ts'

export interface AccuracyVerifierInput {
  gt: GroundTruth
  question: string
  providerId: ProviderId
  answer: string
}

export function promptAccuracyVerifier(input: AccuracyVerifierInput): string {
  const { gt, question, providerId, answer } = input
  return [
    'You are verifying a factual answer against scraped website content.',
    '',
    `URL: ${gt.url}`,
    `Domain: ${gt.domain}`,
    'Scraped body excerpt:',
    gt.bodyExcerpt || '(empty)',
    '',
    `Question: ${question}`,
    `Provider: ${providerId}`,
    `Answer: ${answer}`,
    '',
    'Using ONLY the scraped content as ground truth, decide whether the',
    'answer is correct. If the scrape does not support a definitive',
    'judgment (topic not covered), return correct: null.',
    '',
    'Return ONLY a JSON object with this shape:',
    '{',
    '  "correct": true | false | null,',
    '  "confidence": 0..1,',
    '  "rationale": "..."',
    '}',
  ].join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/prompts.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/prompts.ts tests/unit/llm/prompts.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): accuracy verifier prompt"
```

---

## Task 13 — Judge runner

**Files:**
- Create: `src/llm/judge.ts`
- Create: `tests/unit/llm/judge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/judge.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { runJudge } from '../../../src/llm/judge.ts'
import type { ProbeForJudge } from '../../../src/llm/ground-truth.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme Widgets — the world\'s largest widget maker',
  description: 'We have been making widgets since 1902 in Springfield, serving millions of customers worldwide.',
  h1: 'Industrial widgets built to last',
  bodyExcerpt: 'Four generations of family ownership; A-100 and A-200 flagship products.',
}

const PROBES: ProbeForJudge[] = [
  { key: 'probe_1', provider: 'claude', category: 'coverage', prompt: 'Q1', response: 'R1' },
  { key: 'probe_2', provider: 'gpt', category: 'coverage', prompt: 'Q2', response: 'R2' },
]

const GOOD_JSON = JSON.stringify({
  probe_1: { accuracy: 85, coverage: 80, notes: 'solid' },
  probe_2: { accuracy: 70, coverage: 75, notes: 'ok' },
})

describe('runJudge', () => {
  it('parses raw JSON body and returns per-probe + per-provider', async () => {
    const judge = new MockProvider({ id: 'claude', responses: () => GOOD_JSON })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(false)
    expect(result.perProbe.get('probe_1')?.accuracy).toBe(85)
    expect(result.perProvider.claude?.accuracy).toBe(85)
    expect(result.perProvider.gpt?.coverage).toBe(75)
  })

  it('parses JSON wrapped in fenced code block', async () => {
    const judge = new MockProvider({ id: 'claude', responses: () => '```json\n' + GOOD_JSON + '\n```' })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(false)
    expect(result.perProvider.claude?.accuracy).toBe(85)
  })

  it('parses JSON via first-brace to last-brace substring', async () => {
    const judge = new MockProvider({ id: 'claude', responses: () => `Here is the result:\n${GOOD_JSON}\nDone.` })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(false)
  })

  it('descends one level for { scores: {...} } wrapper', async () => {
    const judge = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({
        scores: {
          probe_1: { accuracy: 90, coverage: 90, notes: 'great' },
          probe_2: { accuracy: 85, coverage: 85, notes: 'good' },
        },
      }),
    })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(false)
    expect(result.perProvider.claude?.accuracy).toBe(90)
  })

  it('retries with a stricter prompt when first response is unparseable', async () => {
    let call = 0
    const judge = new MockProvider({
      id: 'claude',
      responses: () => {
        call++
        return call === 1 ? 'not json at all' : GOOD_JSON
      },
    })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(call).toBe(2)
    expect(result.degraded).toBe(false)
    expect(result.perProvider.claude?.accuracy).toBe(85)
  })

  it('falls back to heuristic (degraded:true) after both tries fail', async () => {
    const judge = new MockProvider({ id: 'claude', responses: () => 'no json here either' })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(true)
    expect(result.perProbe.size).toBe(0)
    expect(result.perProvider.claude).toBeDefined()
    expect(result.perProvider.gpt).toBeDefined()
  })

  it('aggregates multiple probes per provider with averages', async () => {
    const probes: ProbeForJudge[] = [
      { key: 'probe_1', provider: 'claude', category: 'coverage', prompt: 'Q', response: 'R' },
      { key: 'probe_2', provider: 'claude', category: 'coverage', prompt: 'Q', response: 'R' },
    ]
    const body = JSON.stringify({
      probe_1: { accuracy: 90, coverage: 80, notes: 'a' },
      probe_2: { accuracy: 70, coverage: 60, notes: 'b' },
    })
    const judge = new MockProvider({ id: 'claude', responses: () => body })
    const result = await runJudge({ judge, groundTruth: GT, probes })
    expect(result.perProvider.claude?.accuracy).toBe(80)
    expect(result.perProvider.claude?.coverage).toBe(70)
    expect(result.perProvider.claude?.notes).toBe('a | b')
  })

  it('uses the sparse branch when ground truth is sparse', async () => {
    const sparseGT = { url: 'https://a.com', domain: 'a.com', title: 'A', description: '', h1: '', bodyExcerpt: '' }
    const seen: string[] = []
    const judge = new MockProvider({
      id: 'claude',
      responses: (prompt) => { seen.push(prompt); return GOOD_JSON },
    })
    await runJudge({ judge, groundTruth: sparseGT, probes: PROBES })
    expect(seen[0]).toContain('scrape is essentially empty')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/judge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/llm/judge.ts`**

```ts
import { promptJudge } from './prompts.ts'
import type { GroundTruth, ProbeForJudge } from './ground-truth.ts'
import type { Provider, ProviderId, QueryOpts } from './providers/types.ts'

export interface ProbeJudgement {
  accuracy: number
  coverage: number
  notes: string
}

export interface JudgeResult {
  prompt: string
  rawResponse: string
  perProbe: Map<string, ProbeJudgement>
  perProvider: Partial<Record<ProviderId, ProbeJudgement>>
  degraded: boolean
}

export interface RunJudgeInput {
  judge: Provider
  groundTruth: GroundTruth
  probes: ProbeForJudge[]
  signal?: AbortSignal
}

export async function runJudge(input: RunJudgeInput): Promise<JudgeResult> {
  const { judge, groundTruth, probes, signal } = input
  const built = promptJudge(groundTruth, probes)
  const baseOpts: QueryOpts = { temperature: 0 }
  if (signal !== undefined) baseOpts.signal = signal

  let response = await judge.query(built.prompt, baseOpts)
  let perProbe = tryParse(response.text, built.probesByKey)

  if (!perProbe) {
    const stricter = `${built.prompt}\n\nIMPORTANT: Respond with ONLY a JSON object, no prose, no code fences, no preamble.`
    response = await judge.query(stricter, baseOpts)
    perProbe = tryParse(response.text, built.probesByKey)
  }

  if (!perProbe) {
    return {
      prompt: built.prompt,
      rawResponse: response.text,
      perProbe: new Map(),
      perProvider: heuristicFallback(probes, groundTruth),
      degraded: true,
    }
  }

  return {
    prompt: built.prompt,
    rawResponse: response.text,
    perProbe,
    perProvider: aggregateByProvider(perProbe, built.probesByKey),
    degraded: false,
  }
}

function tryParse(
  text: string,
  probesByKey: Map<string, ProbeForJudge>,
): Map<string, ProbeJudgement> | null {
  const candidates: string[] = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1])
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s !== -1 && e > s) candidates.push(text.slice(s, e + 1))

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim())
      if (!parsed || typeof parsed !== 'object') continue
      const top = normalize(parsed as Record<string, unknown>, probesByKey)
      if (top.size > 0) return top
      for (const v of Object.values(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue
        const nested = normalize(v as Record<string, unknown>, probesByKey)
        if (nested.size > 0) return nested
      }
    } catch { /* try next candidate */ }
  }
  return null
}

function normalize(
  raw: Record<string, unknown>,
  probesByKey: Map<string, ProbeForJudge>,
): Map<string, ProbeJudgement> {
  const out = new Map<string, ProbeJudgement>()
  for (const [key, value] of Object.entries(raw)) {
    if (!probesByKey.has(key.trim())) continue
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (typeof v['accuracy'] !== 'number' && typeof v['coverage'] !== 'number') continue
    out.set(key.trim(), {
      accuracy: typeof v['accuracy'] === 'number' ? v['accuracy'] : 0,
      coverage: typeof v['coverage'] === 'number' ? v['coverage'] : 0,
      notes: typeof v['notes'] === 'string' ? v['notes'] : '',
    })
  }
  return out
}

function aggregateByProvider(
  perProbe: Map<string, ProbeJudgement>,
  probesByKey: Map<string, ProbeForJudge>,
): Partial<Record<ProviderId, ProbeJudgement>> {
  const buckets: Partial<Record<ProviderId, ProbeJudgement[]>> = {}
  for (const [key, probe] of probesByKey) {
    const judgement = perProbe.get(key)
    if (!judgement) continue
    const bucket = buckets[probe.provider] ?? []
    bucket.push(judgement)
    buckets[probe.provider] = bucket
  }
  const out: Partial<Record<ProviderId, ProbeJudgement>> = {}
  for (const [provider, list] of Object.entries(buckets) as [ProviderId, ProbeJudgement[]][]) {
    if (!list || list.length === 0) continue
    const accuracy = Math.round(list.reduce((s, j) => s + j.accuracy, 0) / list.length)
    const coverage = Math.round(list.reduce((s, j) => s + j.coverage, 0) / list.length)
    const notes = list.map((j) => j.notes).filter(Boolean).join(' | ')
    out[provider] = { accuracy, coverage, notes }
  }
  return out
}

function heuristicFallback(
  probes: ProbeForJudge[],
  gt: GroundTruth,
): Partial<Record<ProviderId, ProbeJudgement>> {
  const truth = tokenize(`${gt.title} ${gt.description} ${gt.h1} ${gt.bodyExcerpt}`)
  const BASELINE = 60
  const out: Partial<Record<ProviderId, ProbeJudgement>> = {}
  for (const probe of probes) {
    if (!probe.response || probe.response.length === 0) continue
    const words = tokenize(probe.response)
    let overlap = 0
    for (const w of words) if (truth.has(w)) overlap++
    const bonus = Math.min(20, Math.round((overlap / Math.max(1, words.size)) * 200))
    const score = Math.min(100, BASELINE + bonus)
    out[probe.provider] = {
      accuracy: score,
      coverage: score,
      notes: 'fallback (judge parse failed)',
    }
  }
  return out
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3),
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/judge.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/judge.ts tests/unit/llm/judge.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): runJudge with multi-fallback JSON parsing and heuristic degrade"
```

---

## Task 14 — runStaticProbe flow

**Files:**
- Create: `src/llm/flows/static-probe.ts`
- Create: `tests/unit/llm/flows/static-probe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/flows/static-probe.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { runStaticProbe } from '../../../../src/llm/flows/static-probe.ts'

describe('runStaticProbe', () => {
  it('returns response + token counts when no scorer is supplied', async () => {
    const provider = new MockProvider({ id: 'claude', responses: () => 'hello' })
    const r = await runStaticProbe({ provider, prompt: 'hi' })
    expect(r.response).toBe('hello')
    expect(r.prompt).toBe('hi')
    expect(r.score).toBeNull()
    expect(r.scoreRationale).toBeNull()
    expect(r.inputTokens).toBeGreaterThan(0)
  })

  it('applies scorer when supplied', async () => {
    const provider = new MockProvider({ id: 'claude', responses: () => 'a response' })
    const r = await runStaticProbe({
      provider,
      prompt: 'hi',
      scorer: (resp) => ({ score: resp.length, rationale: `len=${resp.length}` }),
    })
    expect(r.score).toBe('a response'.length)
    expect(r.scoreRationale).toBe(`len=${'a response'.length}`)
  })

  it('propagates errors from provider.query', async () => {
    const provider = new MockProvider({ id: 'claude', responses: {}, failWith: 'boom' })
    await expect(runStaticProbe({ provider, prompt: 'x' })).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/flows/static-probe.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/llm/flows/static-probe.ts`**

```ts
import type { Provider, QueryOpts } from '../providers/types.ts'

export interface StaticProbeResult {
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  score: number | null
  scoreRationale: string | null
}

export interface RunStaticProbeInput {
  provider: Provider
  prompt: string
  scorer?: (response: string) => { score: number; rationale: string }
  signal?: AbortSignal
}

export async function runStaticProbe(input: RunStaticProbeInput): Promise<StaticProbeResult> {
  const { provider, prompt, scorer, signal } = input
  const opts: QueryOpts = {}
  if (signal !== undefined) opts.signal = signal
  const r = await provider.query(prompt, opts)
  const scored = scorer ? scorer(r.text) : null
  return {
    prompt,
    response: r.text,
    latencyMs: r.ms,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    score: scored?.score ?? null,
    scoreRationale: scored?.rationale ?? null,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/flows/static-probe.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/flows/static-probe.ts tests/unit/llm/flows/static-probe.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): runStaticProbe flow for static-prompt categories"
```

---

## Task 15 — runSelfGenProbe flow (Discoverability)

**Files:**
- Create: `src/llm/flows/self-gen.ts`
- Create: `tests/unit/llm/flows/self-gen.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/flows/self-gen.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { runSelfGenProbe } from '../../../../src/llm/flows/self-gen.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme', description: 'Widgets', h1: 'Hi', bodyExcerpt: 'body',
}

describe('runSelfGenProbe', () => {
  it('runs stage1 to get a question, then stage2 with that question on same provider', async () => {
    const calls: string[] = []
    const provider = new MockProvider({
      id: 'claude',
      responses: (prompt) => {
        calls.push(prompt)
        return prompt.includes('Do NOT reference')
          ? 'What is the best widget maker?'
          : 'Acme is the best widget maker.'
      },
    })
    const result = await runSelfGenProbe({
      provider,
      groundTruth: GT,
      scorer: ({ text }) => (text.toLowerCase().includes('acme') ? 100 : 0),
    })
    expect(calls).toHaveLength(2)
    expect(result.generator.response).toBe('What is the best widget maker?')
    expect(result.probe.prompt).toBe('What is the best widget maker?')
    expect(result.probe.response).toBe('Acme is the best widget maker.')
    expect(result.score).toBe(100)
  })

  it('throws if stage 1 throws', async () => {
    const provider = new MockProvider({ id: 'claude', responses: {}, failWith: 'stage1 down' })
    await expect(runSelfGenProbe({ provider, groundTruth: GT, scorer: () => 50 })).rejects.toThrow('stage1 down')
  })

  it('throws if stage 2 throws', async () => {
    let call = 0
    const provider = new MockProvider({
      id: 'claude',
      responses: (prompt) => {
        call++
        if (call === 1) return 'generated Q'
        throw new Error('stage2 down')
      },
    })
    await expect(runSelfGenProbe({ provider, groundTruth: GT, scorer: () => 50 })).rejects.toThrow()
  })

  it('passes brand + domain to scorer', async () => {
    let scorerArgs: { text: string; brand: string; domain: string } | null = null
    const provider = new MockProvider({
      id: 'claude',
      responses: (prompt) => (prompt.includes('Do NOT reference') ? 'Q' : 'A'),
    })
    await runSelfGenProbe({
      provider,
      groundTruth: { ...GT, domain: 'stripe.com' },
      scorer: (args) => {
        scorerArgs = args
        return 1
      },
    })
    expect(scorerArgs).not.toBeNull()
    expect(scorerArgs!.brand).toBe('Stripe')
    expect(scorerArgs!.domain).toBe('stripe.com')
    expect(scorerArgs!.text).toBe('A')
  })

  it('includes generator and probe token + latency data', async () => {
    const provider = new MockProvider({
      id: 'claude',
      responses: (prompt) => (prompt.includes('Do NOT') ? 'gen' : 'probe'),
      latencyMs: 5,
    })
    const r = await runSelfGenProbe({ provider, groundTruth: GT, scorer: () => 10 })
    expect(r.generator.latencyMs).toBe(5)
    expect(r.probe.latencyMs).toBe(5)
    expect(r.generator.inputTokens).toBeGreaterThan(0)
    expect(r.probe.outputTokens).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/flows/self-gen.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/llm/flows/self-gen.ts`**

```ts
import { promptDiscoverabilityGenerator } from '../prompts.ts'
import type { GroundTruth } from '../ground-truth.ts'
import type { Provider, QueryOpts } from '../providers/types.ts'
import { brandFromDomain } from '../../scoring/discoverability.ts'

export interface SelfGenStage {
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export interface SelfGenProbeResult {
  generator: SelfGenStage
  probe: SelfGenStage
  score: number
  scoreRationale: string
}

export interface RunSelfGenProbeInput {
  provider: Provider
  groundTruth: GroundTruth
  scorer: (args: { text: string; brand: string; domain: string }) => number
  signal?: AbortSignal
}

export async function runSelfGenProbe(input: RunSelfGenProbeInput): Promise<SelfGenProbeResult> {
  const { provider, groundTruth, scorer, signal } = input
  const opts: QueryOpts = {}
  if (signal !== undefined) opts.signal = signal

  const stage1Prompt = promptDiscoverabilityGenerator(groundTruth)
  const stage1 = await provider.query(stage1Prompt, opts)
  const question = stage1.text.trim()

  const stage2 = await provider.query(question, opts)

  const brand = brandFromDomain(groundTruth.domain)
  const score = scorer({ text: stage2.text, brand, domain: groundTruth.domain })

  return {
    generator: {
      prompt: stage1Prompt,
      response: stage1.text,
      latencyMs: stage1.ms,
      inputTokens: stage1.inputTokens,
      outputTokens: stage1.outputTokens,
    },
    probe: {
      prompt: question,
      response: stage2.text,
      latencyMs: stage2.ms,
      inputTokens: stage2.inputTokens,
      outputTokens: stage2.outputTokens,
    },
    score,
    scoreRationale: `self-gen heuristic (brand=${brand})`,
  }
}
```

(Note: `brandFromDomain` lives in `src/scoring/discoverability.ts` which lands in Task 18. For this task, implementers should defer this import by either: (a) running Task 18 first, OR (b) inlining a private copy of `brandFromDomain` here and replacing with the shared one when Task 18 completes. Recommended: implementers do Task 18 before Task 15, or reorder the task graph.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/flows/self-gen.test.ts`
Expected: PASS (5 tests). Note: this test will also pass with an inlined `brandFromDomain` if the implementer chose that path.

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/flows/self-gen.ts tests/unit/llm/flows/self-gen.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): runSelfGenProbe flow (Discoverability pattern)"
```

---

## Task 16 — runCoverageFlow

**Files:**
- Create: `src/llm/flows/coverage.ts`
- Create: `tests/unit/llm/flows/coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/flows/coverage.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { runCoverageFlow } from '../../../../src/llm/flows/coverage.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme Widgets', description: 'We sell widgets since 1902.', h1: 'Welcome',
  bodyExcerpt: 'Four generations of family ownership. We make widgets worldwide across many construction sites for customers everywhere.',
}

const JUDGE_JSON = JSON.stringify({
  probe_1: { accuracy: 80, coverage: 75, notes: 'c' },
  probe_2: { accuracy: 70, coverage: 65, notes: 'g' },
  probe_3: { accuracy: 75, coverage: 70, notes: 'c2' },
  probe_4: { accuracy: 65, coverage: 60, notes: 'g2' },
})

describe('runCoverageFlow', () => {
  it('runs all coverage prompts across providers and calls the judge', async () => {
    const claude = new MockProvider({ id: 'claude', responses: () => 'claude answer' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'gpt answer' })
    const judge = new MockProvider({ id: 'claude', responses: () => JUDGE_JSON })
    const result = await runCoverageFlow({ providers: [claude, gpt], judge, groundTruth: GT })
    expect(result.probes).toHaveLength(4)
    expect(result.probes.map((p) => p.provider).sort()).toEqual(['claude', 'claude', 'gpt', 'gpt'])
    expect(result.judge.degraded).toBe(false)
  })

  it('works with 4 providers (paid tier)', async () => {
    const judge = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify(Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`probe_${i + 1}`, { accuracy: 80, coverage: 70, notes: '' }]),
      )),
    })
    const providers = [
      new MockProvider({ id: 'claude', responses: () => 'a' }),
      new MockProvider({ id: 'gpt', responses: () => 'a' }),
      new MockProvider({ id: 'gemini', responses: () => 'a' }),
      new MockProvider({ id: 'perplexity', responses: () => 'a' }),
    ]
    const result = await runCoverageFlow({ providers, judge, groundTruth: GT })
    expect(result.probes).toHaveLength(8)
  })

  it('records per-probe errors without aborting the flow', async () => {
    const claude = new MockProvider({ id: 'claude', responses: () => 'ok' })
    const gpt = new MockProvider({ id: 'gpt', responses: {}, failWith: 'rate limited' })
    const judge = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({
        probe_1: { accuracy: 80, coverage: 70, notes: '' },
        probe_2: { accuracy: 75, coverage: 65, notes: '' },
      }),
    })
    const result = await runCoverageFlow({ providers: [claude, gpt], judge, groundTruth: GT })
    const gptProbes = result.probes.filter((p) => p.provider === 'gpt')
    expect(gptProbes).toHaveLength(2)
    expect(gptProbes.every((p) => p.error !== null)).toBe(true)
    expect(gptProbes.every((p) => p.response === '')).toBe(true)
  })

  it('returns degraded judge when all probes fail', async () => {
    const p = new MockProvider({ id: 'claude', responses: {}, failWith: 'down' })
    const judge = new MockProvider({ id: 'claude', responses: () => 'not reached' })
    const result = await runCoverageFlow({ providers: [p], judge, groundTruth: GT })
    expect(result.probes.every((x) => x.error !== null)).toBe(true)
    expect(result.judge.degraded).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/flows/coverage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/llm/flows/coverage.ts`**

```ts
import { promptCoverage } from '../prompts.ts'
import { runJudge } from '../judge.ts'
import type { GroundTruth, ProbeForJudge } from '../ground-truth.ts'
import type { JudgeResult } from '../judge.ts'
import type { Provider, ProviderId, QueryOpts } from '../providers/types.ts'

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

export interface RunCoverageFlowInput {
  providers: Provider[]
  judge: Provider
  groundTruth: GroundTruth
  signal?: AbortSignal
}

export async function runCoverageFlow(input: RunCoverageFlowInput): Promise<CoverageFlowResult> {
  const { providers, judge, groundTruth, signal } = input
  const opts: QueryOpts = {}
  if (signal !== undefined) opts.signal = signal
  const prompts = promptCoverage(groundTruth.domain)

  const tasks: Promise<CoverageProbe>[] = []
  for (const p of providers) {
    for (const prompt of prompts) {
      tasks.push((async (): Promise<CoverageProbe> => {
        try {
          const r = await p.query(prompt, opts)
          return {
            provider: p.id,
            prompt,
            response: r.text,
            latencyMs: r.ms,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            error: null,
          }
        } catch (err) {
          return {
            provider: p.id,
            prompt,
            response: '',
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      })())
    }
  }
  const probes = await Promise.all(tasks)

  const forJudge: ProbeForJudge[] = probes
    .filter((p) => p.response !== '' && p.error === null)
    .map((p, i) => ({
      key: `probe_${i + 1}`,
      provider: p.provider,
      category: 'coverage' as const,
      prompt: p.prompt,
      response: p.response,
    }))

  if (forJudge.length === 0) {
    return {
      probes,
      judge: {
        prompt: '',
        rawResponse: '',
        perProbe: new Map(),
        perProvider: {},
        degraded: true,
      },
    }
  }

  const judgeResult = await runJudge({ judge, groundTruth, probes: forJudge, ...(signal !== undefined ? { signal } : {}) })
  return { probes, judge: judgeResult }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/llm/flows/coverage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/llm/flows/coverage.ts tests/unit/llm/flows/coverage.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): runCoverageFlow (per-provider probes + judge)"
```

---

## Task 17 — Pure scorers: recognition + citation

**Files:**
- Create: `src/scoring/recognition.ts`
- Create: `src/scoring/citation.ts`
- Create: `tests/unit/scoring/recognition.test.ts`
- Create: `tests/unit/scoring/citation.test.ts`

- [ ] **Step 1: Write failing tests for recognition**

Create `tests/unit/scoring/recognition.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { scoreRecognition } from '../../../src/scoring/recognition.ts'

describe('scoreRecognition', () => {
  it('returns 0 for "I don\'t know" responses', () => {
    expect(scoreRecognition({ text: "I don't know about example.com.", domain: 'example.com' })).toBe(0)
    expect(scoreRecognition({ text: "I'm not familiar with that site.", domain: 'example.com' })).toBe(0)
  })

  it('returns 0 when neither brand nor domain is mentioned', () => {
    expect(scoreRecognition({ text: 'It is a search engine.', domain: 'example.com' })).toBe(0)
  })

  it('returns 50 baseline for bare brand mention with no specific facts', () => {
    expect(scoreRecognition({ text: 'Example is a website.', domain: 'example.com' })).toBe(50)
  })

  it('adds 20 for one specific-detail hint', () => {
    expect(scoreRecognition({
      text: 'Example is a company that offers products.',
      domain: 'example.com',
    })).toBe(70)
  })

  it('adds 35 for two hints', () => {
    expect(scoreRecognition({
      text: 'Example was founded in 1998 and is a leading search engine.',
      domain: 'example.com',
    })).toBe(85)
  })

  it('adds 50 for three or more hints', () => {
    expect(scoreRecognition({
      text: 'Example was founded in 1998, is headquartered in California, and is the world\'s largest search engine with billions of users.',
      domain: 'example.com',
    })).toBe(100)
  })

  it('subtracts 20 for hedge phrases', () => {
    expect(scoreRecognition({
      text: "I think Example might be a search engine, but I'm not sure.",
      domain: 'example.com',
    })).toBe(0)
  })

  it('clamps score to 0–100', () => {
    expect(scoreRecognition({ text: 'Example is unknown.', domain: 'example.com' })).toBeGreaterThanOrEqual(0)
    expect(scoreRecognition({
      text: 'Example was founded in 1998, headquartered in California, world\'s largest search engine, billions of users, and offers many products.',
      domain: 'example.com',
    })).toBeLessThanOrEqual(100)
  })
})
```

- [ ] **Step 2: Write failing tests for citation**

Create `tests/unit/scoring/citation.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { scoreCitation } from '../../../src/scoring/citation.ts'

describe('scoreCitation', () => {
  it('returns 100 for canonical URL (with www)', () => {
    expect(scoreCitation({ text: 'The URL is https://www.stripe.com/', domain: 'stripe.com' })).toBe(100)
  })

  it('returns 100 for canonical URL (no www)', () => {
    expect(scoreCitation({ text: 'Visit https://stripe.com/docs', domain: 'stripe.com' })).toBe(100)
  })

  it('returns 80 for same-domain subdomain URL', () => {
    expect(scoreCitation({ text: 'See https://api.stripe.com/v1', domain: 'stripe.com' })).toBe(80)
  })

  it('returns 50 for bare domain token', () => {
    expect(scoreCitation({ text: 'Check out stripe.com for payments.', domain: 'stripe.com' })).toBe(50)
  })

  it('returns 0 when domain is not mentioned at all', () => {
    expect(scoreCitation({ text: 'It is a payment processor.', domain: 'stripe.com' })).toBe(0)
  })

  it('escapes dots in regex so "stripe.com" does not match "stripexcom"', () => {
    expect(scoreCitation({ text: 'Try stripexcom instead.', domain: 'stripe.com' })).toBe(0)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test tests/unit/scoring/recognition.test.ts tests/unit/scoring/citation.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 4: Implement `src/scoring/recognition.ts`**

```ts
const HEDGE_PHRASES = [/i'?m not sure/i, /might be/i, /possibly/i, /i think/i, /not certain/i, /could be/i]
const DONT_KNOW_PHRASES = [/i (do not|don'?t) know/i, /i'?m not familiar/i, /never heard/i, /cannot help/i, /unable to/i]

const SPECIFIC_DETAIL_HINTS: RegExp[] = [
  /founded/i,
  /headquartered/i,
  /\b(19|20)\d{2}\b/,
  /ceo/i,
  /run by/i,
  /owned by/i,
  /\b(acquired|acquired by|operated by)\b/i,
  /\b(subsidiary|division|parent company)\s+of/i,
  /based in/i,
  /\bproducts?\b/i,
  /\bservices?\b/i,
  /\bplatform\b/i,
  /\b(search engine|social network|email service|video platform|marketplace|operating system)\b/i,
  /\b(world'?s|globally|worldwide)\b/i,
  /\b(largest|biggest|leading|major|primary|dominant|popular|most[- ]used)\b/i,
  /\b(million|billion|millions|billions)\s+(of\s+)?(users|customers|people|visits|searches|members)/i,
  /\bprovides?\b/i,
  /\boffers?\b/i,
  /\boperates?\b/i,
  /\bdevelops?\b/i,
  /\bused (in|for|since|by)/i,
]

export interface RecognitionInput {
  text: string
  domain: string
}

export function scoreRecognition({ text, domain }: RecognitionInput): number {
  if (DONT_KNOW_PHRASES.some((rx) => rx.test(text))) return 0

  const lc = text.toLowerCase()
  const brand = brandFromDomainLocal(domain).toLowerCase()
  const mentioned = lc.includes(domain.toLowerCase()) || lc.includes(brand)
  if (!mentioned) return 0

  const matches = SPECIFIC_DETAIL_HINTS.filter((rx) => rx.test(text)).length

  let score = 50
  if (matches >= 3) score += 50
  else if (matches === 2) score += 35
  else if (matches === 1) score += 20

  if (HEDGE_PHRASES.some((rx) => rx.test(text))) score -= 20

  return Math.max(0, Math.min(100, score))
}

function brandFromDomainLocal(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter((p) => p && p !== 'www')
  const candidate = parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!
  return (candidate ?? '').charAt(0).toUpperCase() + (candidate ?? '').slice(1)
}
```

- [ ] **Step 5: Implement `src/scoring/citation.ts`**

```ts
export interface CitationInput {
  text: string
  domain: string
}

export function scoreCitation({ text, domain }: CitationInput): number {
  const d = escapeRegex(domain)
  const canonical = new RegExp(`https?://(www\\.)?${d}(/|\\b)`, 'i')
  if (canonical.test(text)) return 100
  const subdomain = new RegExp(`https?://[a-z0-9-]+\\.${d}(/|\\b)`, 'i')
  if (subdomain.test(text)) return 80
  if (new RegExp(`\\b${d}\\b`, 'i').test(text)) return 50
  return 0
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test tests/unit/scoring/recognition.test.ts tests/unit/scoring/citation.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 7: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/scoring/recognition.ts src/scoring/citation.ts tests/unit/scoring/recognition.test.ts tests/unit/scoring/citation.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): pure scorers — recognition and citation"
```

---

## Task 18 — Pure scorer: discoverability + brandFromDomain

**Files:**
- Create: `src/scoring/discoverability.ts`
- Create: `tests/unit/scoring/discoverability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scoring/discoverability.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { scoreDiscoverability, brandFromDomain } from '../../../src/scoring/discoverability.ts'

describe('brandFromDomain', () => {
  it('extracts brand from TLD domain', () => {
    expect(brandFromDomain('stripe.com')).toBe('Stripe')
  })
  it('strips leading www', () => {
    expect(brandFromDomain('www.stripe.com')).toBe('Stripe')
  })
  it('takes second-to-last segment from subdomain', () => {
    expect(brandFromDomain('api.stripe.com')).toBe('Stripe')
  })
  it('handles single-segment hostnames', () => {
    expect(brandFromDomain('localhost')).toBe('Localhost')
  })
})

describe('scoreDiscoverability', () => {
  it('returns 0 when neither brand nor domain is mentioned', () => {
    expect(scoreDiscoverability({ text: 'It is a tool.', brand: 'Stripe', domain: 'stripe.com' })).toBe(0)
  })

  it('returns 50 for bare brand mention', () => {
    expect(scoreDiscoverability({ text: 'Stripe is used.', brand: 'Stripe', domain: 'stripe.com' })).toBe(50)
  })

  it('returns 30 for bare domain mention without brand', () => {
    expect(scoreDiscoverability({ text: 'See stripe.com.', brand: 'Stripe', domain: 'stripe.com' })).toBe(30)
  })

  it('adds brand+domain to 80', () => {
    expect(scoreDiscoverability({ text: 'Stripe lives at stripe.com.', brand: 'Stripe', domain: 'stripe.com' })).toBe(80)
  })

  it('bumps to 80 when brand is mentioned with a recommendation phrase (no URL)', () => {
    expect(scoreDiscoverability({
      text: 'Stripe is the leading payment processor.',
      brand: 'Stripe', domain: 'stripe.com',
    })).toBe(80)
  })

  it('bumps to 100 for brand + URL + recommendation', () => {
    expect(scoreDiscoverability({
      text: 'Stripe (stripe.com) is the industry standard for payments.',
      brand: 'Stripe', domain: 'stripe.com',
    })).toBe(100)
  })

  it('suppresses recommendation bonus when brand appears in list of alternatives', () => {
    expect(scoreDiscoverability({
      text: 'Popular options include Stripe, Square, Adyen for payments.',
      brand: 'Stripe', domain: 'stripe.com',
    })).toBe(50)
  })

  it('clamps score to 0–100', () => {
    const s = scoreDiscoverability({
      text: 'Stripe (stripe.com) is the de-facto industry standard, the most widely used.',
      brand: 'Stripe', domain: 'stripe.com',
    })
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/scoring/discoverability.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/scoring/discoverability.ts`**

```ts
const RECOMMENDATION_HINTS: RegExp[] = [
  /\bthe best\b/i,
  /\bthe top\b/i,
  /\bbest (choice|option|tool|fit|way)\b/i,
  /\bmost (common|popular|widely[- ]used|reliable|trusted|effective|powerful)\b/i,
  /\bgo[- ]to\b/i,
  /\bleading\b/i,
  /\bpreferred\b/i,
  /\bindustry standard\b/i,
  /\brecommend(ed)?\b/i,
  /\b(largest|biggest|dominant)\b/i,
  /\bworld'?s (largest|biggest|most|leading)\b/i,
  /\b(top|first|primary)\s+(choice|pick|recommendation|option)\b/i,
  /\bcommonly used\b/i,
  /\bwidely (used|adopted)\b/i,
  /\b(de[- ]facto|de facto)\b/i,
  /\b(defaults? to|default choice)\b/i,
]

export interface DiscoverabilityInput {
  text: string
  brand: string
  domain: string
}

export function scoreDiscoverability({ text, brand, domain }: DiscoverabilityInput): number {
  const brandRx = new RegExp(`\\b${escapeRegex(brand)}\\b`, 'i')
  const domainRx = new RegExp(`\\b${escapeRegex(domain)}\\b`, 'i')
  const urlRx = new RegExp(`https?://(www\\.)?${escapeRegex(domain)}`, 'i')

  const mentionsBrand = brandRx.test(text)
  const mentionsDomain = domainRx.test(text) || urlRx.test(text)

  if (!mentionsBrand && !mentionsDomain) return 0

  let score = 0
  if (mentionsBrand) score += 50
  if (mentionsDomain) score += 30

  const altListRx = /\b[A-Z][a-zA-Z]{2,},\s*[A-Z][a-zA-Z]{2,},\s*[A-Z][a-zA-Z]{2,}/
  const inAltList = altListRx.test(text)

  const hasRecommendationPhrase = !inAltList && RECOMMENDATION_HINTS.some((rx) => rx.test(text))
  if (hasRecommendationPhrase && mentionsBrand) {
    if (mentionsDomain) score = 100
    else if (score < 80) score = 80
  }

  return Math.max(0, Math.min(100, score))
}

export function brandFromDomain(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter((p) => p && p !== 'www')
  const candidate = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
  const c = candidate ?? ''
  return c.charAt(0).toUpperCase() + c.slice(1)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/scoring/discoverability.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/scoring/discoverability.ts tests/unit/scoring/discoverability.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): pure scorer — discoverability + brandFromDomain"
```

---

## Task 19 — Letter grade, weights, composite

**Files:**
- Create: `src/scoring/letter.ts`
- Create: `src/scoring/weights.ts`
- Create: `src/scoring/composite.ts`
- Create: `tests/unit/scoring/letter.test.ts`
- Create: `tests/unit/scoring/composite.test.ts`

- [ ] **Step 1: Write failing tests for letter**

Create `tests/unit/scoring/letter.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { toLetterGrade } from '../../../src/scoring/letter.ts'

describe('toLetterGrade', () => {
  it('maps 100 → A+', () => expect(toLetterGrade(100)).toBe('A+'))
  it('maps 97 → A+', () => expect(toLetterGrade(97)).toBe('A+'))
  it('maps 96 → A', () => expect(toLetterGrade(96)).toBe('A'))
  it('maps 93 → A', () => expect(toLetterGrade(93)).toBe('A'))
  it('maps 90 → A−', () => expect(toLetterGrade(90)).toBe('A−'))
  it('maps 87 → B+', () => expect(toLetterGrade(87)).toBe('B+'))
  it('maps 83 → B', () => expect(toLetterGrade(83)).toBe('B'))
  it('maps 80 → B−', () => expect(toLetterGrade(80)).toBe('B−'))
  it('maps 77 → C+', () => expect(toLetterGrade(77)).toBe('C+'))
  it('maps 70 → C−', () => expect(toLetterGrade(70)).toBe('C−'))
  it('maps 60 → D', () => expect(toLetterGrade(60)).toBe('D'))
  it('maps 0 → F', () => expect(toLetterGrade(0)).toBe('F'))
  it('maps 50 → F', () => expect(toLetterGrade(50)).toBe('F'))
})
```

- [ ] **Step 2: Write failing tests for composite**

Create `tests/unit/scoring/composite.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { weightedOverall } from '../../../src/scoring/composite.ts'
import { DEFAULT_WEIGHTS } from '../../../src/scoring/weights.ts'

describe('weightedOverall', () => {
  it('computes the weighted overall when all six categories are scored', () => {
    const r = weightedOverall({
      discoverability: 100, recognition: 80, accuracy: 60, coverage: 70, citation: 50, seo: 40,
    }, DEFAULT_WEIGHTS)
    // 100*30 + 80*20 + 60*20 + 70*10 + 50*10 + 40*10 = 3000 + 1600 + 1200 + 700 + 500 + 400 = 7400 / 100 = 74
    expect(r.overall).toBe(74)
    expect(r.letter).toBe('C')
    expect(r.droppedCategories).toEqual([])
  })

  it('renormalizes when accuracy is null', () => {
    const r = weightedOverall({
      discoverability: 100, recognition: 80, accuracy: null, coverage: 70, citation: 50, seo: 40,
    }, DEFAULT_WEIGHTS)
    // total weight scored = 30+20+10+10+10 = 80
    // weighted = 100*30 + 80*20 + 70*10 + 50*10 + 40*10 = 3000+1600+700+500+400 = 6200
    // overall = round(6200 / 80) = 78
    expect(r.overall).toBe(78)
    expect(r.droppedCategories).toEqual(['accuracy'])
  })

  it('drops multiple null categories and still computes a valid score', () => {
    const r = weightedOverall({
      discoverability: 100, recognition: 80, accuracy: null, coverage: null, citation: 50, seo: null,
    }, DEFAULT_WEIGHTS)
    // scored weight = 30+20+10 = 60
    // weighted = 100*30 + 80*20 + 50*10 = 3000+1600+500 = 5100 / 60 = 85
    expect(r.overall).toBe(85)
    expect(r.droppedCategories.sort()).toEqual(['accuracy', 'coverage', 'seo'].sort())
  })

  it('returns overall 0 / letter F when all categories are null', () => {
    const r = weightedOverall({
      discoverability: null, recognition: null, accuracy: null, coverage: null, citation: null, seo: null,
    }, DEFAULT_WEIGHTS)
    expect(r.overall).toBe(0)
    expect(r.letter).toBe('F')
    expect(r.droppedCategories.length).toBe(6)
  })

  it('treats missing keys as dropped categories', () => {
    const r = weightedOverall({
      discoverability: 100, recognition: 100,
    }, DEFAULT_WEIGHTS)
    expect(r.droppedCategories.sort()).toEqual(['accuracy', 'citation', 'coverage', 'seo'].sort())
    expect(r.overall).toBe(100)
  })

  it('usedWeights renormalizes to sum to 100', () => {
    const r = weightedOverall({
      discoverability: 50, recognition: 50, accuracy: null, coverage: null, citation: null, seo: null,
    }, DEFAULT_WEIGHTS)
    const sum = Object.values(r.usedWeights).reduce((s, n) => s + n, 0)
    expect(sum).toBe(100)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test tests/unit/scoring/letter.test.ts tests/unit/scoring/composite.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 4: Implement `src/scoring/letter.ts`**

```ts
const LETTER_THRESHOLDS: [number, string][] = [
  [97, 'A+'], [93, 'A'], [90, 'A−'],
  [87, 'B+'], [83, 'B'], [80, 'B−'],
  [77, 'C+'], [73, 'C'], [70, 'C−'],
  [60, 'D'], [0, 'F'],
]

export function toLetterGrade(score: number): string {
  for (const [threshold, letter] of LETTER_THRESHOLDS) {
    if (score >= threshold) return letter
  }
  return 'F'
}
```

- [ ] **Step 5: Implement `src/scoring/weights.ts`**

```ts
export type CategoryId =
  | 'discoverability'
  | 'recognition'
  | 'accuracy'
  | 'coverage'
  | 'citation'
  | 'seo'

export const DEFAULT_WEIGHTS: Record<CategoryId, number> = {
  discoverability: 30,
  recognition: 20,
  accuracy: 20,
  coverage: 10,
  citation: 10,
  seo: 10,
}
```

- [ ] **Step 6: Implement `src/scoring/composite.ts`**

```ts
import { toLetterGrade } from './letter.ts'
import type { CategoryId } from './weights.ts'

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
): OverallScore {
  const all = Object.keys(weights) as CategoryId[]
  const scored: CategoryId[] = []
  const dropped: CategoryId[] = []
  for (const c of all) {
    const v = scores[c]
    if (typeof v === 'number' && Number.isFinite(v)) scored.push(c)
    else dropped.push(c)
  }

  const totalScoredWeight = scored.reduce((s, c) => s + weights[c], 0)
  const weightedSum = scored.reduce((s, c) => s + (scores[c] as number) * weights[c], 0)
  const overall = totalScoredWeight === 0 ? 0 : Math.round(weightedSum / totalScoredWeight)

  const usedWeights: Record<CategoryId, number> = {
    discoverability: 0, recognition: 0, accuracy: 0, coverage: 0, citation: 0, seo: 0,
  }
  if (totalScoredWeight > 0) {
    let distributed = 0
    scored.forEach((c, i) => {
      if (i === scored.length - 1) {
        usedWeights[c] = 100 - distributed
      } else {
        const pct = Math.round((weights[c] / totalScoredWeight) * 100)
        usedWeights[c] = pct
        distributed += pct
      }
    })
  }

  return {
    overall,
    letter: toLetterGrade(overall),
    usedWeights,
    droppedCategories: dropped,
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test tests/unit/scoring/letter.test.ts tests/unit/scoring/composite.test.ts`
Expected: PASS (19 tests).

- [ ] **Step 8: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/scoring/letter.ts src/scoring/weights.ts src/scoring/composite.ts tests/unit/scoring/letter.test.ts tests/unit/scoring/composite.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): letter grade, weights, and composite overall scorer"
```

---

## Task 20 — Accuracy generator

**Files:**
- Create: `src/accuracy/generator.ts`
- Create: `tests/unit/accuracy/generator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/accuracy/generator.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { generateQuestion } from '../../../src/accuracy/generator.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme', description: 'Widgets', h1: 'Welcome', bodyExcerpt: 'We sell widgets since 1902.',
}

describe('generateQuestion', () => {
  it('returns the generator response as the question', async () => {
    const gen = new MockProvider({ id: 'gpt', responses: () => 'When was Acme founded?' })
    const result = await generateQuestion({ generator: gen, groundTruth: GT })
    expect(result.question).toBe('When was Acme founded?')
    expect(result.prompt).toContain('factual question')
    expect(result.response).toBe('When was Acme founded?')
  })

  it('strips leading/trailing quotes and whitespace', async () => {
    const gen = new MockProvider({ id: 'gpt', responses: () => '  "When was Acme founded?"  ' })
    const result = await generateQuestion({ generator: gen, groundTruth: GT })
    expect(result.question).toBe('When was Acme founded?')
  })

  it('re-throws provider errors', async () => {
    const gen = new MockProvider({ id: 'gpt', responses: {}, failWith: 'generator down' })
    await expect(generateQuestion({ generator: gen, groundTruth: GT })).rejects.toThrow('generator down')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/accuracy/generator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/accuracy/generator.ts`**

```ts
import { promptAccuracyGenerator } from '../llm/prompts.ts'
import type { GroundTruth } from '../llm/ground-truth.ts'
import type { Provider, QueryOpts } from '../llm/providers/types.ts'

export interface GeneratedQuestion {
  question: string
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export interface GenerateQuestionInput {
  generator: Provider
  groundTruth: GroundTruth
  signal?: AbortSignal
}

export async function generateQuestion(input: GenerateQuestionInput): Promise<GeneratedQuestion> {
  const { generator, groundTruth, signal } = input
  const prompt = promptAccuracyGenerator(groundTruth)
  const opts: QueryOpts = { temperature: 0.3 }
  if (signal !== undefined) opts.signal = signal
  const r = await generator.query(prompt, opts)
  const question = r.text.trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '').trim()
  return {
    question,
    prompt,
    response: r.text,
    latencyMs: r.ms,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/accuracy/generator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/accuracy/generator.ts tests/unit/accuracy/generator.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): accuracy generator — produce a site-specific question"
```

---

## Task 21 — Accuracy verifier

**Files:**
- Create: `src/accuracy/verifier.ts`
- Create: `tests/unit/accuracy/verifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/accuracy/verifier.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { verifyAnswer } from '../../../src/accuracy/verifier.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme', description: 'Widgets since 1902.', h1: 'Welcome',
  bodyExcerpt: 'Acme was founded in 1902 in Springfield.',
}

const ANSWER = {
  providerId: 'claude' as const,
  answer: 'Acme was founded in 1902.',
  latencyMs: 10, inputTokens: 5, outputTokens: 7, error: null,
}

describe('verifyAnswer', () => {
  it('parses correct:true JSON', async () => {
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: true, confidence: 0.9, rationale: 'matches scrape' }),
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'When was Acme founded?', probeAnswer: ANSWER })
    expect(r.correct).toBe(true)
    expect(r.confidence).toBe(0.9)
    expect(r.rationale).toBe('matches scrape')
    expect(r.degraded).toBe(false)
  })

  it('parses correct:false JSON', async () => {
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: false, confidence: 0.95, rationale: 'wrong year' }),
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(r.correct).toBe(false)
  })

  it('parses correct:null JSON', async () => {
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: null, confidence: 0.1, rationale: 'scrape does not say' }),
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(r.correct).toBe(null)
  })

  it('parses JSON inside a fenced code block', async () => {
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => '```json\n{"correct":true,"confidence":0.8,"rationale":"ok"}\n```',
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(r.correct).toBe(true)
  })

  it('retries with stricter prompt on first parse failure', async () => {
    let call = 0
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => {
        call++
        return call === 1 ? 'not json' : JSON.stringify({ correct: true, confidence: 0.5, rationale: 'x' })
      },
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(call).toBe(2)
    expect(r.correct).toBe(true)
    expect(r.degraded).toBe(false)
  })

  it('returns degraded result when JSON cannot be parsed after retry', async () => {
    const verifier = new MockProvider({ id: 'claude', responses: () => 'still not json' })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(r.degraded).toBe(true)
    expect(r.correct).toBe(null)
    expect(r.confidence).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/accuracy/verifier.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/accuracy/verifier.ts`**

```ts
import { promptAccuracyVerifier } from '../llm/prompts.ts'
import type { GroundTruth } from '../llm/ground-truth.ts'
import type { Provider, ProviderId, QueryOpts } from '../llm/providers/types.ts'

export interface ProbeAnswer {
  providerId: ProviderId
  answer: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  error: string | null
}

export interface VerificationResult {
  providerId: ProviderId
  correct: boolean | null
  confidence: number
  rationale: string
  prompt: string
  rawResponse: string
  degraded: boolean
}

export interface VerifyAnswerInput {
  verifier: Provider
  groundTruth: GroundTruth
  question: string
  probeAnswer: ProbeAnswer
  signal?: AbortSignal
}

export async function verifyAnswer(input: VerifyAnswerInput): Promise<VerificationResult> {
  const { verifier, groundTruth, question, probeAnswer, signal } = input
  const prompt = promptAccuracyVerifier({
    gt: groundTruth,
    question,
    providerId: probeAnswer.providerId,
    answer: probeAnswer.answer,
  })
  const opts: QueryOpts = { temperature: 0 }
  if (signal !== undefined) opts.signal = signal

  let response = await verifier.query(prompt, opts)
  let parsed = tryParse(response.text)

  if (!parsed) {
    const stricter = `${prompt}\n\nIMPORTANT: Respond with ONLY a JSON object, no prose, no code fences.`
    response = await verifier.query(stricter, opts)
    parsed = tryParse(response.text)
  }

  if (!parsed) {
    return {
      providerId: probeAnswer.providerId,
      correct: null,
      confidence: 0,
      rationale: 'verifier parse failed',
      prompt,
      rawResponse: response.text,
      degraded: true,
    }
  }

  return {
    providerId: probeAnswer.providerId,
    correct: parsed.correct,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    prompt,
    rawResponse: response.text,
    degraded: false,
  }
}

interface Parsed { correct: boolean | null; confidence: number; rationale: string }

function tryParse(text: string): Parsed | null {
  const candidates: string[] = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1])
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s !== -1 && e > s) candidates.push(text.slice(s, e + 1))

  for (const c of candidates) {
    try {
      const raw = JSON.parse(c.trim())
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const correct = r['correct']
      const confidence = r['confidence']
      const rationale = r['rationale']
      if (correct !== true && correct !== false && correct !== null) continue
      if (typeof confidence !== 'number') continue
      if (typeof rationale !== 'string') continue
      return { correct, confidence, rationale }
    } catch { /* try next */ }
  }
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/accuracy/verifier.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/accuracy/verifier.ts tests/unit/accuracy/verifier.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): accuracy verifier with multi-pattern JSON parse + degraded fallback"
```

---

## Task 22 — runAccuracy orchestrator

**Files:**
- Create: `src/accuracy/index.ts`
- Create: `tests/unit/accuracy/run-accuracy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/accuracy/run-accuracy.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { runAccuracy } from '../../../src/accuracy/index.ts'
import type { ScrapeResult } from '../../../src/scraper/index.ts'

const URL = 'https://acme.com'
const SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: 'Acme was founded in 1902 in Springfield. We make industrial widgets. Family-owned for four generations, used across North America.',
  structured: {
    jsonld: [], og: {}, meta: { title: 'Acme', description: 'Widgets since 1902.' },
    headings: { h1: ['Welcome'], h2: [] },
    robots: null,
    sitemap: { present: false, url: '' }, llmsTxt: { present: false, url: '' },
  },
}

const SPARSE_SCRAPE: ScrapeResult = { ...SCRAPE, text: 'too short' }

const GEN = new MockProvider({ id: 'gpt', responses: () => 'When was Acme founded?' })

function makeVerifier(table: Record<string, { correct: boolean | null; confidence?: number; rationale?: string }>) {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      for (const [providerMarker, v] of Object.entries(table)) {
        if (prompt.includes(`Provider: ${providerMarker}`)) {
          return JSON.stringify({ correct: v.correct, confidence: v.confidence ?? 0.9, rationale: v.rationale ?? '' })
        }
      }
      throw new Error('verifier: unrecognized provider')
    },
  })
}

describe('runAccuracy', () => {
  it('returns insufficient_scrape for text < 500 chars without making any LLM calls', async () => {
    const result = await runAccuracy({
      generator: GEN,
      verifier: makeVerifier({}),
      probers: [],
      url: URL,
      scrape: SPARSE_SCRAPE,
    })
    expect(result.reason).toBe('insufficient_scrape')
    expect(result.score).toBeNull()
    expect(result.generator).toBeNull()
    expect(result.probes).toEqual([])
    expect(GEN.calls.length).toBe(0)
  })

  it('full happy path with 2 probers — all correct → score 100', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const claude = new MockProvider({ id: 'claude', responses: () => 'Founded in 1902.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Founded in 1902.' })
    const verifier = makeVerifier({ claude: { correct: true }, gpt: { correct: true } })
    const result = await runAccuracy({
      generator: GEN, verifier, probers: [claude, gpt], url: URL, scrape: longScrape,
    })
    expect(result.reason).toBe('ok')
    expect(result.score).toBe(100)
    expect(result.valid).toBe(2)
    expect(result.correct).toBe(2)
    expect(result.probes).toHaveLength(2)
    expect(result.verifications).toHaveLength(2)
  })

  it('4-prober paid tier with mixed correct/false/null gives correct/valid math', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const probers = [
      new MockProvider({ id: 'claude', responses: () => 'a1' }),
      new MockProvider({ id: 'gpt', responses: () => 'a2' }),
      new MockProvider({ id: 'gemini', responses: () => 'a3' }),
      new MockProvider({ id: 'perplexity', responses: () => 'a4' }),
    ]
    const verifier = makeVerifier({
      claude: { correct: true },
      gpt: { correct: false },
      gemini: { correct: null },
      perplexity: { correct: true },
    })
    const result = await runAccuracy({
      generator: GEN, verifier, probers, url: URL, scrape: longScrape,
    })
    expect(result.reason).toBe('ok')
    expect(result.valid).toBe(3) // one null dropped
    expect(result.correct).toBe(2)
    expect(result.score).toBe(67) // round(2/3*100)
  })

  it('re-throws generator errors (no fallback at the orchestrator)', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const gen = new MockProvider({ id: 'gpt', responses: {}, failWith: 'generator down' })
    await expect(runAccuracy({
      generator: gen,
      verifier: makeVerifier({}),
      probers: [new MockProvider({ id: 'claude', responses: () => 'a' })],
      url: URL,
      scrape: longScrape,
    })).rejects.toThrow('generator down')
  })

  it('records per-prober errors without aborting (other probers still verified)', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const claude = new MockProvider({ id: 'claude', responses: () => 'ok' })
    const gpt = new MockProvider({ id: 'gpt', responses: {}, failWith: 'rate' })
    const verifier = makeVerifier({ claude: { correct: true } })
    const result = await runAccuracy({
      generator: GEN, verifier, probers: [claude, gpt], url: URL, scrape: longScrape,
    })
    expect(result.probes).toHaveLength(2)
    expect(result.probes.find((p) => p.providerId === 'gpt')?.error).toBeTruthy()
    expect(result.verifications).toHaveLength(1) // only claude got verified
    expect(result.score).toBe(100)
    expect(result.reason).toBe('ok')
  })

  it('reason all_null when every verification returns correct:null', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const claude = new MockProvider({ id: 'claude', responses: () => 'vague' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'vague' })
    const verifier = makeVerifier({ claude: { correct: null }, gpt: { correct: null } })
    const result = await runAccuracy({
      generator: GEN, verifier, probers: [claude, gpt], url: URL, scrape: longScrape,
    })
    expect(result.reason).toBe('all_null')
    expect(result.score).toBeNull()
    expect(result.valid).toBe(0)
  })

  it('reason all_failed when every prober throws', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const p1 = new MockProvider({ id: 'claude', responses: {}, failWith: 'down' })
    const p2 = new MockProvider({ id: 'gpt', responses: {}, failWith: 'down' })
    const result = await runAccuracy({
      generator: GEN, verifier: makeVerifier({}), probers: [p1, p2], url: URL, scrape: longScrape,
    })
    expect(result.reason).toBe('all_failed')
    expect(result.verifications).toEqual([])
    expect(result.probes.every((p) => p.error !== null)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/accuracy/run-accuracy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/accuracy/index.ts`**

```ts
import { generateQuestion } from './generator.ts'
import { verifyAnswer } from './verifier.ts'
import { toGroundTruth } from '../llm/ground-truth.ts'
import type { GeneratedQuestion } from './generator.ts'
import type { ProbeAnswer, VerificationResult } from './verifier.ts'
import type { ScrapeResult } from '../scraper/index.ts'
import type { Provider, QueryOpts } from '../llm/providers/types.ts'

export type { GeneratedQuestion } from './generator.ts'
export type { ProbeAnswer, VerificationResult } from './verifier.ts'
export { generateQuestion } from './generator.ts'
export { verifyAnswer } from './verifier.ts'

export type AccuracyReason = 'ok' | 'insufficient_scrape' | 'all_null' | 'all_failed'

export interface AccuracyResult {
  score: number | null
  reason: AccuracyReason
  generator: GeneratedQuestion | null
  probes: ProbeAnswer[]
  verifications: VerificationResult[]
  valid: number
  correct: number
}

export interface RunAccuracyInput {
  generator: Provider
  verifier: Provider
  probers: Provider[]
  url: string
  scrape: ScrapeResult
  signal?: AbortSignal
}

const SCRAPE_MIN_CHARS = 500

export async function runAccuracy(input: RunAccuracyInput): Promise<AccuracyResult> {
  const { generator, verifier, probers, url, scrape, signal } = input

  if (scrape.text.length < SCRAPE_MIN_CHARS) {
    return {
      score: null,
      reason: 'insufficient_scrape',
      generator: null,
      probes: [],
      verifications: [],
      valid: 0,
      correct: 0,
    }
  }

  const gt = toGroundTruth(url, scrape)

  const genInput = signal !== undefined
    ? { generator, groundTruth: gt, signal }
    : { generator, groundTruth: gt }
  const gen = await generateQuestion(genInput)

  const probeOpts: QueryOpts = { temperature: 0.7 }
  if (signal !== undefined) probeOpts.signal = signal

  const probes: ProbeAnswer[] = await Promise.all(
    probers.map(async (p): Promise<ProbeAnswer> => {
      try {
        const r = await p.query(gen.question, probeOpts)
        return {
          providerId: p.id,
          answer: r.text,
          latencyMs: r.ms,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          error: null,
        }
      } catch (err) {
        return {
          providerId: p.id,
          answer: '',
          latencyMs: 0, inputTokens: 0, outputTokens: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  const verifiable = probes.filter((p) => p.answer !== '' && p.error === null)
  const verifications: VerificationResult[] = await Promise.all(
    verifiable.map((p) => verifyAnswer({
      verifier, groundTruth: gt, question: gen.question, probeAnswer: p,
      ...(signal !== undefined ? { signal } : {}),
    })),
  )

  const valid = verifications.filter((v) => v.correct !== null).length
  const correct = verifications.filter((v) => v.correct === true).length

  let reason: AccuracyReason
  let score: number | null
  if (verifications.length === 0) {
    reason = 'all_failed'
    score = null
  } else if (valid === 0) {
    reason = 'all_null'
    score = null
  } else {
    reason = 'ok'
    score = Math.round((correct / valid) * 100)
  }

  return { score, reason, generator: gen, probes, verifications, valid, correct }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/accuracy/`
Expected: PASS (16 tests across generator + verifier + run-accuracy).

- [ ] **Step 5: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/accuracy/index.ts tests/unit/accuracy/run-accuracy.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): runAccuracy orchestrator — full generator → blind probe → per-provider verifier flow"
```

---

## Task 23 — Public re-exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Append Plan 4 re-exports to `src/index.ts`**

Append after the existing Plan 3 re-exports:
```ts
// Plan 4 — providers
export type { Provider, ProviderId, QueryOpts, QueryResult } from './llm/providers/types.ts'
export {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  PerplexityProvider,
  MockProvider,
  buildProviders,
  ProviderError,
  classifyStatus,
} from './llm/providers/index.ts'
export type {
  MockProviderOptions,
  MockResponses,
  MockCall,
  ProviderKeys,
  DirectProviders,
  ProviderErrorKind,
} from './llm/providers/index.ts'

// Plan 4 — ground truth + prompts + judge
export { toGroundTruth, isSparseGroundTruth } from './llm/ground-truth.ts'
export type { GroundTruth, ProbeForJudge } from './llm/ground-truth.ts'
export {
  promptRecognition,
  promptCoverage,
  promptCitation,
  promptDiscoverabilityGenerator,
  promptAccuracyGenerator,
  promptJudge,
  promptAccuracyVerifier,
} from './llm/prompts.ts'
export type { BuiltJudgePrompt, AccuracyVerifierInput } from './llm/prompts.ts'
export { runJudge } from './llm/judge.ts'
export type { JudgeResult, ProbeJudgement, RunJudgeInput } from './llm/judge.ts'

// Plan 4 — flows
export { runStaticProbe } from './llm/flows/static-probe.ts'
export type { StaticProbeResult, RunStaticProbeInput } from './llm/flows/static-probe.ts'
export { runSelfGenProbe } from './llm/flows/self-gen.ts'
export type { SelfGenProbeResult, SelfGenStage, RunSelfGenProbeInput } from './llm/flows/self-gen.ts'
export { runCoverageFlow } from './llm/flows/coverage.ts'
export type { CoverageFlowResult, CoverageProbe, RunCoverageFlowInput } from './llm/flows/coverage.ts'

// Plan 4 — pure scoring
export { scoreRecognition } from './scoring/recognition.ts'
export type { RecognitionInput } from './scoring/recognition.ts'
export { scoreCitation } from './scoring/citation.ts'
export type { CitationInput } from './scoring/citation.ts'
export { scoreDiscoverability, brandFromDomain } from './scoring/discoverability.ts'
export type { DiscoverabilityInput } from './scoring/discoverability.ts'
export { toLetterGrade } from './scoring/letter.ts'
export { DEFAULT_WEIGHTS } from './scoring/weights.ts'
export type { CategoryId } from './scoring/weights.ts'
export { weightedOverall } from './scoring/composite.ts'
export type { CategoryScores, OverallScore } from './scoring/composite.ts'

// Plan 4 — accuracy
export {
  runAccuracy,
  generateQuestion,
  verifyAnswer,
} from './accuracy/index.ts'
export type {
  AccuracyResult,
  AccuracyReason,
  GeneratedQuestion,
  VerificationResult,
  ProbeAnswer,
  RunAccuracyInput,
} from './accuracy/index.ts'
```

- [ ] **Step 2: Run typecheck to verify all new exports resolve**

Run: `pnpm typecheck`
Expected: PASS — no unresolved exports.

- [ ] **Step 3: Run full unit test suite**

Run: `pnpm test`
Expected: PASS — roughly 125 new tests plus all existing (Plans 1-3) tests.

- [ ] **Step 4: Commit**

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/index.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): re-export Plan 4 scoring engine surface"
```

---

## Task 24 — Final verification

**Files:** none.

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — 0 errors.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS — previous Plan 1-3 tests (87) + ~125 new = ~212 total passing.

- [ ] **Step 3: Build bundles**

Run: `pnpm build`
Expected: PASS — `dist/server.js` and `dist/worker.js` regenerated with no bundler errors.

- [ ] **Step 4: Inspect module boundaries**

Run these greps to confirm invariants held:
```bash
# src/scoring/ must not import from src/llm/, src/scraper/, src/seo/, src/db/, src/queue/, src/store/, src/server/, src/worker/
grep -R "from '\.\./llm" src/scoring/ || true
grep -R "from '\.\./scraper" src/scoring/ || true
grep -R "from '\.\./seo" src/scoring/ || true
grep -R "from '\.\./db\|from '\.\./queue\|from '\.\./store\|from '\.\./server\|from '\.\./worker" src/scoring/ || true

# src/llm/ must not import from src/db/, src/queue/, src/store/, src/server/, src/worker/
grep -R "from '\.\./\.\./db\|from '\.\./\.\./queue\|from '\.\./\.\./store\|from '\.\./\.\./server\|from '\.\./\.\./worker" src/llm/ || true
grep -R "from '\.\./db\|from '\.\./queue\|from '\.\./store\|from '\.\./server\|from '\.\./worker" src/llm/ || true

# src/accuracy/ must not import from src/scoring/
grep -R "from '\.\./scoring" src/accuracy/ || true
```

Expected: no output from any of these commands. If anything shows up, investigate before continuing.

- [ ] **Step 5: Confirm test counts match plan**

Run: `pnpm test 2>&1 | tail -20`
Expected: total passing count ~212. No failures, no skips.

- [ ] **Step 6: Commit verification summary (optional)**

If the previous five steps turned up anything non-trivial (e.g. additional tests needed, missed import guard), fix it in-branch, run typecheck + tests again, and commit. Otherwise, no additional commit is required — Task 23 is the last meaningful commit.

- [ ] **Step 7: Hand off to finishing-a-development-branch**

The subagent-driven-development controller should now invoke `superpowers:finishing-a-development-branch` to present merge/PR/keep/discard options.

---

## Plan 4 completion checklist

Before marking this plan complete, verify:

- [ ] All 24 tasks committed (rough commit count: 20+ across the plan; some tasks share a commit).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green (unit only; no integration tests in this plan).
- [ ] `pnpm build` green.
- [ ] `src/index.ts` re-exports everything listed in sub-spec §10.
- [ ] No imports from `src/scoring/` into `src/llm/`, `src/scraper/`, `src/seo/`, or `src/db/**`.
- [ ] No imports from `src/llm/` into `src/db/**`, `src/queue/**`, `src/store/**`, `src/server/**`, `src/worker/**`.
- [ ] No imports from `src/accuracy/` into `src/scoring/`.
- [ ] No real-provider calls in any test.
- [ ] No new runtime or dev dependencies.

## Task dependency note (for subagent-driven-development controller)

Task 15 (`runSelfGenProbe`) imports `brandFromDomain` from `src/scoring/discoverability.ts`, which is created in Task 18. The task order in this plan lists 15 before 18 because the narrative groups flows with other flows and pure scorers together. **Recommended execution order is to do Task 18 before Task 15**, OR have the implementer inline a private `brandFromDomain` in Task 15 and refactor later. The controller should flag this to the implementer when dispatching Task 15.
