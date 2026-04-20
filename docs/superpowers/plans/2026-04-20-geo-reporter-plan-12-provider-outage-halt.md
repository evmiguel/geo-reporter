# Plan 12 — Provider-outage halt + paid-flow gate + generating-report UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** If Claude or OpenAI probes fail terminally (after OpenRouter fallback) during the free grade, halt the pipeline, refund the rate-limit slot, and render a clean outage page. Block `/billing/redeem-credit` and `/billing/checkout` with `409 provider_outage` before consuming a credit or creating a Stripe session when the underlying grade has Claude/OpenAI terminal failures. After a successful redeem, render "Generating report…" in the button slot instead of leaving the button mounted.

**Architecture:** Discoverability probe becomes a canary — runs sequentially before the parallel Promise.all. A new `GradeStore.hasTerminalProviderFailures(gradeId)` method backs both the worker canary and the paid-flow gate (same SQL, same semantics). Rate-limit bucket is refactored from one-shot middleware to peek-then-commit, so the worker can call `removeFromBucket(key, member)` when it halts. A new `failedKind` discriminator on the `failed` SSE event + reducer state drives the frontend outage rendering.

**Tech Stack:** TypeScript 5.6+ strict profile, Hono 4, BullMQ 5 + ioredis 5, Drizzle + postgres-js, React 18 + React Router, Vitest 2 + testcontainers 10. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-20-geo-reporter-plan-12-provider-outage-halt-design.md`

---

## Phase A — Bucket refund plumbing

### Task 1: Refactor bucket + rate-limit for gradeId-correlated refund

**Files:**
- Modify: `src/server/middleware/bucket.ts`
- Modify: `src/server/middleware/rate-limit.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/routes/grades.ts`
- Test: `tests/unit/server/middleware/bucket.test.ts` (new)
- Test: `tests/unit/server/middleware/rate-limit.test.ts` (update if exists; otherwise new)

**Why the refactor:** today `rateLimitMiddleware` calls `checkRateLimit` which atomically peeks + commits. To refund a specific grade's slot from the worker, the member added to the sorted set must be correlatable to the grade. Split into peek-then-commit so the commit happens *after* `createGrade` and carries the gradeId as the member.

- [ ] **Step 1: Write the failing test for `removeFromBucket`**

Create `tests/unit/server/middleware/bucket.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { makeStubRedis } from '../../_helpers/stub-redis.ts'
import { peekBucket, addToBucket, removeFromBucket } from '../../../../src/server/middleware/bucket.ts'

describe('bucket', () => {
  const cfg = { key: 'bucket:test', limit: 3, windowMs: 60_000 }
  let redis: ReturnType<typeof makeStubRedis>
  beforeEach(() => { redis = makeStubRedis() })

  it('addToBucket with named member stores that exact member', async () => {
    await addToBucket(redis, cfg, 1000, 'grade:abc')
    const peek = await peekBucket(redis, cfg, 1000)
    expect(peek.used).toBe(1)
  })

  it('removeFromBucket removes exactly the named member (refund)', async () => {
    await addToBucket(redis, cfg, 1000, 'grade:abc')
    await addToBucket(redis, cfg, 1001, 'grade:def')
    await removeFromBucket(redis, { key: cfg.key }, 'grade:abc')
    const peek = await peekBucket(redis, cfg, 2000)
    expect(peek.used).toBe(1)
  })

  it('removeFromBucket on unknown member is a no-op', async () => {
    await addToBucket(redis, cfg, 1000, 'grade:abc')
    await removeFromBucket(redis, { key: cfg.key }, 'grade:zzz')
    const peek = await peekBucket(redis, cfg, 2000)
    expect(peek.used).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/server/middleware/bucket.test.ts`
Expected: FAIL — `removeFromBucket` not exported.

- [ ] **Step 3: Update `bucket.ts`**

Replace the contents of `src/server/middleware/bucket.ts`:

```ts
import type Redis from 'ioredis'

export interface BucketConfig {
  key: string
  limit: number
  windowMs: number
}

export interface BucketResult {
  allowed: boolean
  limit: number
  used: number
  retryAfter: number
}

export async function peekBucket(redis: Redis, cfg: BucketConfig, now: number): Promise<BucketResult> {
  const cutoff = now - cfg.windowMs
  // Half-open window: (cutoff, now]. Expire STRICTLY less than cutoff.
  await redis.zremrangebyscore(cfg.key, '-inf', String(cutoff - 1))
  const used = await redis.zcard(cfg.key)
  if (used >= cfg.limit) {
    const range = await redis.zrange(cfg.key, 0, 0, 'WITHSCORES')
    const oldestScore = range.length >= 2 ? Number(range[1]) : now
    const retryAfter = Math.ceil((oldestScore + cfg.windowMs - now) / 1000)
    return { allowed: false, limit: cfg.limit, used, retryAfter }
  }
  return { allowed: true, limit: cfg.limit, used, retryAfter: 0 }
}

export async function addToBucket(
  redis: Redis, cfg: BucketConfig, now: number, member: string,
): Promise<void> {
  await redis.zadd(cfg.key, now, member)
  await redis.expire(cfg.key, Math.ceil(cfg.windowMs / 1000))
}

export async function removeFromBucket(
  redis: Redis, cfg: { key: string }, member: string,
): Promise<void> {
  await redis.zrem(cfg.key, member)
}
```

- [ ] **Step 4: Run bucket test to verify it passes**

Run: `pnpm test tests/unit/server/middleware/bucket.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Update `rate-limit.ts` to split peek + commit**

Replace the contents of `src/server/middleware/rate-limit.ts`:

```ts
import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import { peekBucket, addToBucket, removeFromBucket, type BucketResult } from './bucket.ts'

const WINDOW_MS = 86_400_000
const ANON_LIMIT = 3
const CREDITS_LIMIT = 10

export type PaywallReason = 'email' | 'daily_cap'

export interface RateLimitPeekResult extends BucketResult {
  paywall: PaywallReason
}

export function gradeBucketKey(ip: string, cookie: string): string {
  return `bucket:ip:${ip}+cookie:${cookie}`
}

export function gradeBucketMember(gradeId: string): string {
  return `grade:${gradeId}`
}

async function bucketCfg(store: GradeStore, cookie: string): Promise<{ limit: number; paywall: PaywallReason }> {
  const row = await store.getCookieWithUserAndCredits(cookie)
  const hasCredits = row.credits > 0
  return {
    limit: hasCredits ? CREDITS_LIMIT : ANON_LIMIT,
    paywall: hasCredits ? 'daily_cap' : 'email',
  }
}

export async function peekRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, now: number = Date.now(),
): Promise<RateLimitPeekResult> {
  const { limit, paywall } = await bucketCfg(store, cookie)
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  const peek = await peekBucket(redis, cfg, now)
  return { ...peek, paywall }
}

export async function commitRateLimit(
  redis: Redis, store: GradeStore, ip: string, cookie: string, gradeId: string, now: number = Date.now(),
): Promise<void> {
  const { limit } = await bucketCfg(store, cookie)
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  await addToBucket(redis, cfg, now, gradeBucketMember(gradeId))
}

export async function refundRateLimit(
  redis: Redis, ip: string, cookie: string, gradeId: string,
): Promise<void> {
  await removeFromBucket(redis, { key: gradeBucketKey(ip, cookie) }, gradeBucketMember(gradeId))
}

type Env = { Variables: { clientIp: string; cookie: string } }

export function rateLimitMiddleware(redis: Redis, store: GradeStore): MiddlewareHandler<Env> {
  return async (c, next) => {
    const result = await peekRateLimit(redis, store, c.var.clientIp, c.var.cookie)
    if (!result.allowed) {
      return c.json({
        paywall: result.paywall,
        limit: result.limit,
        used: result.used,
        retryAfter: result.retryAfter,
      }, 429)
    }
    await next()
  }
}
```

- [ ] **Step 6: Update `POST /grades` to commit rate limit after grade creation**

In `src/server/routes/grades.ts`, update the POST handler:

```ts
import { commitRateLimit } from '../middleware/rate-limit.ts'
// ... existing imports
  app.post('/', zValidator('json', CreateGradeBody), async (c) => {
    const { url } = c.req.valid('json')
    const parsed = new URL(url)
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const grade = await deps.store.createGrade({
      url, domain, tier: 'free', cookie: c.var.cookie, userId: null, status: 'queued',
    })
    await commitRateLimit(deps.redis, deps.store, c.var.clientIp, c.var.cookie, grade.id)
    await enqueueGrade({ gradeId: grade.id, tier: 'free', ip: c.var.clientIp, cookie: c.var.cookie }, deps.redis)
    return c.json({ gradeId: grade.id }, 202)
  })
```

(The new `ip` and `cookie` fields on `GradeJob` are added in Task 2.)

- [ ] **Step 7: Run all rate-limit / grades / middleware tests**

Run: `pnpm test tests/unit/server/middleware tests/unit/server/routes/grades && pnpm typecheck`
Expected: PASS. Any existing test that called `checkRateLimit` must be migrated to `peekRateLimit` — fix inline if present. (`checkRateLimit` no longer exists.)

- [ ] **Step 8: Commit**

```bash
git add src/server/middleware/bucket.ts src/server/middleware/rate-limit.ts src/server/routes/grades.ts tests/unit/server/middleware/bucket.test.ts tests/unit/server/middleware/rate-limit.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "refactor(server): split rate-limit into peek/commit for gradeId-correlated refund"
```

---

### Task 2: Extend `GradeJob` payload with `ip` + `cookie`

**Files:**
- Modify: `src/queue/queues.ts`
- Modify: `src/queue/workers/run-grade/run-grade.ts`
- Modify: `src/server/routes/grades.ts` (already done in Task 1 Step 6 — just verify)
- Test: `tests/unit/queue/queues-payload.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/queue/queues-payload.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { GradeJob } from '../../../src/queue/queues.ts'

describe('GradeJob payload', () => {
  it('accepts ip + cookie alongside gradeId + tier', () => {
    const job: GradeJob = {
      gradeId: 'g1', tier: 'free', ip: '127.0.0.1', cookie: 'cookie-1',
    }
    expect(job.ip).toBe('127.0.0.1')
    expect(job.cookie).toBe('cookie-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/queues-payload.test.ts`
Expected: FAIL — `ip` and `cookie` not on `GradeJob`.

- [ ] **Step 3: Extend `GradeJob` interface**

In `src/queue/queues.ts`, replace `GradeJob`:

```ts
export interface GradeJob {
  gradeId: string
  tier: 'free' | 'paid'
  ip: string
  cookie: string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/queue/queues-payload.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix existing callers + typecheck**

Run: `pnpm typecheck`
Expected: typecheck failures at call sites that build `GradeJob` literals. Fix each:

- `src/server/routes/grades.ts`: already updated in Task 1 Step 6 to include `ip: c.var.clientIp, cookie: c.var.cookie`. Verify.
- Any test that constructs `GradeJob` (grep for `tier: 'free'`): add `ip: 'test-ip', cookie: 'test-cookie'`.

After fixing:
```
pnpm typecheck && pnpm test
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/queue/queues.ts src/server/routes/grades.ts tests/unit/queue/queues-payload.test.ts tests/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(queue): add ip + cookie to GradeJob (for worker-side rate-limit refund)"
```

---

## Phase B — Store: hasTerminalProviderFailures

### Task 3: `GradeStore.hasTerminalProviderFailures`

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/postgres.ts`
- Modify: `tests/unit/_helpers/fake-store.ts`
- Test: `tests/integration/store-has-terminal-provider-failures.test.ts` (new)

- [ ] **Step 1: Add method to the interface**

In `src/store/types.ts`, add to the `GradeStore` interface (near the other grade-related methods):

```ts
  hasTerminalProviderFailures(gradeId: string): Promise<boolean>
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/store-has-terminal-provider-failures.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.hasTerminalProviderFailures', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  async function freshGrade(): Promise<string> {
    const g = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: `c-${Math.random()}`, userId: null, status: 'running',
    })
    return g.id
  }

  it('returns false when all Claude/OpenAI probes have a score', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'claude', prompt: 'p', response: 'r', score: 50, metadata: {} })
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'openai', prompt: 'p', response: 'r', score: 50, metadata: {} })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(false)
  })

  it('returns true when Claude has a null score + error metadata', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'claude', prompt: '', response: '', score: null, metadata: { error: 'Anthropic 500' } })
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'openai', prompt: 'p', response: 'r', score: 50, metadata: {} })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(true)
  })

  it('returns true when OpenAI has a null score + error metadata', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'claude', prompt: 'p', response: 'r', score: 50, metadata: {} })
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'openai', prompt: '', response: '', score: null, metadata: { error: 'OpenAI 429' } })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(true)
  })

  it('returns false when null score has no error metadata (intentional skip)', async () => {
    // Accuracy flow sets `role: 'skipped'` with null score but no error.
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'accuracy', provider: 'claude', prompt: '', response: '', score: null, metadata: { role: 'skipped', reason: 'no ground truth' } })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(false)
  })

  it('ignores Gemini + Perplexity failures (only Claude + OpenAI gate)', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'recognition', provider: 'gemini', prompt: '', response: '', score: null, metadata: { error: 'Gemini down' } })
    await store.createProbe({ gradeId, category: 'recognition', provider: 'perplexity', prompt: '', response: '', score: null, metadata: { error: 'Perplexity down' } })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:integration tests/integration/store-has-terminal-provider-failures.test.ts`
Expected: FAIL — method not implemented.

- [ ] **Step 4: Implement in `PostgresStore`**

Add to `src/store/postgres.ts` (alongside the other probe-related methods):

```ts
async hasTerminalProviderFailures(gradeId: string): Promise<boolean> {
  const rows = await this.db.execute(sql`
    SELECT 1 FROM probes
    WHERE grade_id = ${gradeId}
      AND provider IN ('claude', 'openai')
      AND score IS NULL
      AND metadata ? 'error'
    LIMIT 1
  `)
  return rows.length > 0
}
```

Make sure `sql` is imported from `drizzle-orm`. If the file already imports it, skip. Otherwise add:
```ts
import { sql } from 'drizzle-orm'
```

Note: the provider column uses the literal string `'openai'` for GPT today (check `src/llm/providers/openai.ts` — the exported `id` is `'openai'`, not `'gpt'`). The test uses `'openai'` to match.

- [ ] **Step 5: Implement in fake-store**

In `tests/unit/_helpers/fake-store.ts`, add a `hasTerminalProviderFailures` method that iterates the probes map:

```ts
async hasTerminalProviderFailures(gradeId: string): Promise<boolean> {
  for (const probe of this.probesMap.values()) {
    if (probe.gradeId !== gradeId) continue
    if (probe.provider !== 'claude' && probe.provider !== 'openai') continue
    if (probe.score !== null) continue
    const meta = probe.metadata as Record<string, unknown>
    if (typeof meta.error === 'string') return true
  }
  return false
}
```

Adapt the field name (`probesMap`) to whatever the fake-store uses — read the file first.

- [ ] **Step 6: Run integration test**

Run: `pnpm test:integration tests/integration/store-has-terminal-provider-failures.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Run unit suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts tests/integration/store-has-terminal-provider-failures.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): hasTerminalProviderFailures(gradeId) for Claude/OpenAI outage detection"
```

---

## Phase C — SSE event `kind` + reducer

### Task 4: Extend `failed` event with `kind` + wire through reducer

**Files:**
- Modify: `src/queue/events.ts`
- Modify: `src/web/lib/types.ts`
- Modify: `src/web/lib/grade-reducer.ts`
- Modify: `src/queue/workers/run-grade/run-grade.ts` (catch block only — worker halt path lands in Task 5)
- Modify: `src/server/routes/grades-events.ts` if it forwards event shape (check first)
- Test: `tests/unit/web/lib/grade-reducer.test.ts` (add case)

- [ ] **Step 1: Write the failing test**

Open `tests/unit/web/lib/grade-reducer.test.ts` and add a new `it(...)`:

```ts
it('reduces failed event with kind=provider_outage into state.failedKind', () => {
  const state = initialGradeState()
  const next = reduceGradeEvents(
    state,
    { type: 'failed', kind: 'provider_outage', error: 'Anthropic 500 after retries' },
    0,
  )
  expect(next.phase).toBe('failed')
  expect(next.failedKind).toBe('provider_outage')
  expect(next.error).toBe('Anthropic 500 after retries')
})

it('reduces failed event with kind=other into state.failedKind', () => {
  const state = initialGradeState()
  const next = reduceGradeEvents(
    state,
    { type: 'failed', kind: 'other', error: 'scrape too small' },
    0,
  )
  expect(next.failedKind).toBe('other')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/web/lib/grade-reducer.test.ts`
Expected: FAIL — `failedKind` not on state, `kind` not on event.

- [ ] **Step 3: Extend the event union in `src/queue/events.ts`**

Find the line `| { type: 'failed'; error: string }` and replace with:

```ts
  | { type: 'failed'; kind: 'provider_outage' | 'other'; error: string }
```

- [ ] **Step 4: Mirror the change in `src/web/lib/types.ts`**

`GradeEvent` in the web types file also has `| { type: 'failed'; error: string }`. Replace the same way:

```ts
  | { type: 'failed'; kind: 'provider_outage' | 'other'; error: string }
```

- [ ] **Step 5: Extend `GradeState` in `src/web/lib/types.ts`**

Add `failedKind` to the `GradeState` interface:

```ts
export interface GradeState {
  phase: Phase
  // ...
  error: string | null
  failedKind: 'provider_outage' | 'other' | null   // NEW
  paidStatus: PaidStatus
  // ...
}
```

- [ ] **Step 6: Update `initialGradeState` + reducer**

In `src/web/lib/grade-reducer.ts`:

1. Add `failedKind: null` to the object returned by `initialGradeState`.

2. Update the `case 'failed'` branch:

```ts
case 'failed':
  return { ...state, phase: 'failed', error: event.error, failedKind: event.kind }
```

- [ ] **Step 7: Update the worker's catch block**

In `src/queue/workers/run-grade/run-grade.ts`, the catch block at the bottom:

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  await deps.store.updateGrade(gradeId, { status: 'failed' })
  await publishGradeEvent(deps.redis, gradeId, { type: 'failed', kind: 'other', error: message })
  throw err
}
```

- [ ] **Step 8: Check `grades-events.ts` SSE forwarder + `generate-report` emitter**

Run: `grep -rn "type: 'failed'" src/`

Update every call site that publishes `{ type: 'failed', error: ... }` to include `kind: 'other'`. Likely culprits: `src/queue/workers/run-grade/run-grade.ts` (updated above), any `publishGradeEvent` call site that emits `failed`. Leave `report.failed` alone — different event type.

- [ ] **Step 9: Run tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/queue/events.ts src/queue/workers/run-grade/run-grade.ts src/web/lib/types.ts src/web/lib/grade-reducer.ts tests/unit/web/lib/grade-reducer.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(events): add kind discriminator to failed event + failedKind reducer state"
```

---

## Phase D — Worker canary halt

### Task 5: Extract discoverability as canary + halt path

**Files:**
- Create: `src/queue/workers/run-grade/outage-detect.ts`
- Modify: `src/queue/workers/run-grade/run-grade.ts`
- Modify: `src/queue/workers/run-grade/deps.ts` (if needed — add anything missing)
- Test: `tests/unit/queue/workers/run-grade/outage-detect.test.ts` (new)
- Test: `tests/unit/queue/workers/run-grade/run-grade.halt.test.ts` (new)

- [ ] **Step 1: Create the detector (thin wrapper for symmetry with the paid gate)**

Create `src/queue/workers/run-grade/outage-detect.ts`:

```ts
import type { GradeStore } from '../../../store/types.ts'

export async function detectClaudeOrOpenAIOutage(
  gradeId: string,
  store: GradeStore,
): Promise<{ message: string } | null> {
  const hasFailure = await store.hasTerminalProviderFailures(gradeId)
  return hasFailure
    ? { message: 'An LLM provider (Claude or OpenAI) returned a terminal error after fallback retries.' }
    : null
}
```

- [ ] **Step 2: Write the failing detector test**

Create `tests/unit/queue/workers/run-grade/outage-detect.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'
import { detectClaudeOrOpenAIOutage } from '../../../../../src/queue/workers/run-grade/outage-detect.ts'

describe('detectClaudeOrOpenAIOutage', () => {
  it('returns null when no terminal failures exist', async () => {
    const store = makeFakeStore()
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: 'c', userId: null, status: 'running' })
    await store.createProbe({ gradeId: grade.id, category: 'discoverability', provider: 'claude', prompt: 'p', response: 'r', score: 50, metadata: {} })
    expect(await detectClaudeOrOpenAIOutage(grade.id, store)).toBeNull()
  })

  it('returns an object with a message when Claude terminal-failed', async () => {
    const store = makeFakeStore()
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: 'c', userId: null, status: 'running' })
    await store.createProbe({ gradeId: grade.id, category: 'discoverability', provider: 'claude', prompt: '', response: '', score: null, metadata: { error: 'Anthropic 500' } })
    const result = await detectClaudeOrOpenAIOutage(grade.id, store)
    expect(result).not.toBeNull()
    expect(result!.message).toMatch(/provider/i)
  })
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test tests/unit/queue/workers/run-grade/outage-detect.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Write the failing halt-path test for `runGrade`**

Create `tests/unit/queue/workers/run-grade/run-grade.halt.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { Job } from 'bullmq'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'
import { makeStubRedis } from '../../../_helpers/stub-redis.ts'
import type { Provider } from '../../../../../src/llm/providers/types.ts'
import type { RunGradeDeps } from '../../../../../src/queue/workers/run-grade/deps.ts'
import { runGrade } from '../../../../../src/queue/workers/run-grade/run-grade.ts'
import type { GradeJob } from '../../../../../src/queue/queues.ts'

function makeProviderThatFails(id: 'claude' | 'openai' | 'gemini' | 'perplexity'): Provider {
  return {
    id: id as Provider['id'],
    model: `${id}-test`,
    async call() { throw new Error(`${id} is terminally down`) },
  } as unknown as Provider
}
function makeOkProvider(id: 'claude' | 'openai' | 'gemini' | 'perplexity'): Provider {
  return {
    id: id as Provider['id'],
    model: `${id}-test`,
    async call() { return { text: 'ok', inputTokens: 1, outputTokens: 1, latencyMs: 10 } as never },
  } as unknown as Provider
}

function makeScrapeFn() {
  return async () => ({
    html: '<html>acme</html>',
    text: 'acme is a company that does stuff and has a website '.repeat(5),
    rendered: false,
    structured: {} as never,
  })
}

describe('runGrade canary halt', () => {
  async function setup(claudeFails: boolean, gptFails: boolean) {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const grade = await store.createGrade({
      url: 'https://acme.test', domain: 'acme.test', tier: 'free',
      cookie: 'test-cookie', userId: null, status: 'queued',
    })
    const job = { data: { gradeId: grade.id, tier: 'free', ip: '127.0.0.1', cookie: 'test-cookie' } } as unknown as Job<GradeJob>

    const deps: RunGradeDeps = {
      store, redis,
      providers: {
        claude: claudeFails ? makeProviderThatFails('claude') : makeOkProvider('claude'),
        gpt: gptFails ? makeProviderThatFails('openai') : makeOkProvider('openai'),
        gemini: makeOkProvider('gemini'),
        perplexity: makeOkProvider('perplexity'),
      } as unknown as RunGradeDeps['providers'],
      scrapeFn: makeScrapeFn(),
    }
    return { store, redis, grade, job, deps }
  }

  it('halts with provider_outage when Claude terminal-fails on discoverability', async () => {
    const { store, job, deps, grade } = await setup(true, false)
    await runGrade(job, deps)
    const fresh = await store.getGrade(grade.id)
    expect(fresh?.status).toBe('failed')
    // No subsequent category probes were written (recognition/citation/coverage/accuracy)
    const probes = await store.listProbes(grade.id)
    const categories = new Set(probes.map((p) => p.category))
    expect(categories.has('recognition')).toBe(false)
    expect(categories.has('accuracy')).toBe(false)
  })

  it('halts with provider_outage when OpenAI terminal-fails on discoverability', async () => {
    const { store, job, deps, grade } = await setup(false, true)
    await runGrade(job, deps)
    const fresh = await store.getGrade(grade.id)
    expect(fresh?.status).toBe('failed')
  })

  it('does NOT halt when only Gemini/Perplexity fail (free tier does not use them, but sanity check)', async () => {
    const { store, job, deps, grade } = await setup(false, false)
    await runGrade(job, deps)
    const fresh = await store.getGrade(grade.id)
    expect(fresh?.status).toBe('done')
  })
})
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm test tests/unit/queue/workers/run-grade/run-grade.halt.test.ts`
Expected: FAIL — halt path not wired; categories keep running.

- [ ] **Step 6: Refactor `run-grade.ts` — pull discoverability out of `Promise.all`, add canary check**

Replace the try block in `src/queue/workers/run-grade/run-grade.ts`:

```ts
import { refundRateLimit } from '../../../server/middleware/rate-limit.ts'
import { detectClaudeOrOpenAIOutage } from './outage-detect.ts'
// ... (existing imports)

export async function runGrade(job: Job<GradeJob>, deps: RunGradeDeps): Promise<void> {
  const { gradeId, tier, ip, cookie } = job.data
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

    // SEO first (sync, instant)
    const seoScore = await runSeoCategory({ gradeId, scrape, deps })

    // Discoverability acts as canary — runs sequentially across providers, so
    // any Claude/OpenAI terminal error lands in the DB before the parallel
    // block fans out. On outage, halt + refund + graceful return.
    const discScore = await runDiscoverabilityCategory({ gradeId, grade, scrape, probers, deps })

    const outage = await detectClaudeOrOpenAIOutage(gradeId, deps.store)
    if (outage !== null) {
      await refundRateLimit(deps.redis, ip, cookie, gradeId)
      await deps.store.updateGrade(gradeId, { status: 'failed' })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'failed', kind: 'provider_outage', error: outage.message,
      })
      return  // graceful return — do NOT throw; BullMQ should NOT retry a provider outage.
    }

    const [recScore, citScore, covScore, accScore] = await Promise.all([
      runRecognitionCategory({ gradeId, grade, scrape, probers, deps }),
      runCitationCategory({ gradeId, grade, scrape, probers, deps }),
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
    await publishGradeEvent(deps.redis, gradeId, { type: 'failed', kind: 'other', error: message })
    throw err
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm test tests/unit/queue/workers/run-grade/run-grade.halt.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Full unit suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Existing run-grade tests may fail because `Promise.all` no longer includes discoverability — update assertions accordingly if any test asserted specific call ordering.

- [ ] **Step 9: Commit**

```bash
git add src/queue/workers/run-grade/outage-detect.ts src/queue/workers/run-grade/run-grade.ts tests/unit/queue/workers/run-grade/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(worker): discoverability canary halts on Claude/OpenAI terminal outage"
```

---

### Task 6: Integration test — bucket refund end-to-end

**Files:**
- Test: `tests/integration/rate-limit-refund.test.ts` (new)

- [ ] **Step 1: Write the test**

Create `tests/integration/rate-limit-refund.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, type TestDb } from './setup.ts'
import { startTestRedis, type TestRedis } from './setup-redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { peekRateLimit, commitRateLimit, refundRateLimit } from '../../src/server/middleware/rate-limit.ts'

describe('rate-limit commit + refund', () => {
  let db: TestDb
  let redis: TestRedis
  let store: PostgresStore

  beforeAll(async () => {
    db = await startTestDb()
    redis = await startTestRedis()
    store = new PostgresStore(db.db)
  }, 120_000)
  afterAll(async () => {
    await redis.stop()
    await db.stop()
  })

  it('commit + refund cycles a slot, allowing subsequent grade', async () => {
    const ip = '10.0.0.1'
    const cookie = 'cookie-refund-test'

    // Committed 3 times (anon limit) — next peek says denied
    await commitRateLimit(redis.client, store, ip, cookie, 'grade-1')
    await commitRateLimit(redis.client, store, ip, cookie, 'grade-2')
    await commitRateLimit(redis.client, store, ip, cookie, 'grade-3')
    const denied = await peekRateLimit(redis.client, store, ip, cookie)
    expect(denied.allowed).toBe(false)

    // Refund one — peek allows again
    await refundRateLimit(redis.client, ip, cookie, 'grade-2')
    const allowed = await peekRateLimit(redis.client, store, ip, cookie)
    expect(allowed.allowed).toBe(true)
    expect(allowed.used).toBe(2)
  })
})
```

If `tests/integration/setup-redis.ts` doesn't exist, check what helper is used in existing integration tests (e.g., `tests/integration/setup.ts` may export both db and redis, or there's `makeIntegrationRedis`). Read one existing integration test first and mirror its setup.

- [ ] **Step 2: Run the test**

Run: `pnpm test:integration tests/integration/rate-limit-refund.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/rate-limit-refund.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(integration): rate-limit commit + refund cycle"
```

---

## Phase E — Paid-flow gate

### Task 7: `provider_outage` 409 in `/billing/redeem-credit`

**Files:**
- Modify: `src/server/routes/billing.ts`
- Test: `tests/unit/server/routes/billing-redeem-credit.test.ts` (modify — add case)

- [ ] **Step 1: Write the failing test**

Open `tests/unit/server/routes/billing-redeem-credit.test.ts`. Inside the existing `describe('POST /billing/redeem-credit', ...)`, add:

```ts
it('409 provider_outage when grade has Claude or OpenAI terminal probe failures; credits untouched', async () => {
  const { app, store } = build()
  const cookie = await issueCookie(app)
  const uuid = cookie.split('.')[0]!
  const user = await store.upsertUser('outage@example.com')
  await store.upsertCookie(uuid, user.id)
  // Give user 5 credits so we can assert no decrement
  await store.createStripePayment({ gradeId: null, sessionId: 'cs_grant', amountCents: 2900, currency: 'usd', kind: 'credits' })
  await store.grantCreditsAndMarkPaid('cs_grant', user.id, 5, 2900, 'usd')
  const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, userId: user.id, status: 'done' })
  // Seed a terminal Claude failure
  await store.createProbe({
    gradeId: grade.id, category: 'discoverability', provider: 'claude',
    prompt: '', response: '', score: null, metadata: { error: 'Anthropic 500' },
  })

  const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify({ gradeId: grade.id }),
  }))

  expect(res.status).toBe(409)
  const body = await res.json() as { error: string }
  expect(body.error).toBe('provider_outage')

  // Credits untouched
  expect(await store.getCredits(user.id)).toBe(5)
})
```

Re-use the existing `build()` / `issueCookie()` helpers in that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/server/routes/billing-redeem-credit.test.ts`
Expected: FAIL — route still returns 204 (or decrements credit).

- [ ] **Step 3: Add the gate in `billing.ts`**

In `src/server/routes/billing.ts`, find the `/redeem-credit` handler. After the grade ownership / status checks, BEFORE the already-paid check and BEFORE the credit-decrement step, insert:

```ts
if (await deps.store.hasTerminalProviderFailures(grade.id)) {
  return c.json({ error: 'provider_outage' }, 409)
}
```

The exact insertion point: right after the `grade_not_done` check (status check) and right before the existing `already_paid` check. The order matters — we want to short-circuit before any side effect.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/server/routes/billing-redeem-credit.test.ts`
Expected: PASS (+1 new, all existing pass).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/billing.ts tests/unit/server/routes/billing-redeem-credit.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): reject redeem-credit with provider_outage when grade has Claude/OpenAI failures"
```

---

### Task 8: `provider_outage` 409 in `/billing/checkout`

**Files:**
- Modify: `src/server/routes/billing.ts`
- Test: `tests/unit/server/routes/billing-checkout.test.ts` (add case)

- [ ] **Step 1: Write the failing test**

Open `tests/unit/server/routes/billing-checkout.test.ts`. Add:

```ts
it('409 provider_outage when grade has Claude/OpenAI terminal failures; no Stripe session created', async () => {
  const { app, store, billing } = build()
  const cookie = await issueCookie(app)
  const uuid = await verifyCookie(store, cookie, 'outage@example.com')
  const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
  await store.createProbe({
    gradeId: grade.id, category: 'discoverability', provider: 'openai',
    prompt: '', response: '', score: null, metadata: { error: 'OpenAI 429' },
  })

  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify({ gradeId: grade.id }),
  }))

  expect(res.status).toBe(409)
  const body = await res.json() as { error: string }
  expect(body.error).toBe('provider_outage')
  expect(billing.createdSessions).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/server/routes/billing-checkout.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the gate in `billing.ts`**

In the `/checkout` handler, the same placement pattern: after status check, before any side effect (already-paid lookup, credit short-circuit, Stripe session creation). Insert:

```ts
if (await deps.store.hasTerminalProviderFailures(grade.id)) {
  return c.json({ error: 'provider_outage' }, 409)
}
```

- [ ] **Step 4: Run test + full suite**

Run: `pnpm test tests/unit/server/routes/billing-checkout.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/billing.ts tests/unit/server/routes/billing-checkout.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): reject checkout with provider_outage when grade has Claude/OpenAI failures"
```

---

## Phase F — Frontend: outage UX + generating loader

### Task 9: Extend API client result unions with `provider_outage`

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Update `CheckoutResult` + parse**

In `src/web/lib/api.ts`, extend `CheckoutResult`:

```ts
export type CheckoutResult =
  | { ok: true; kind: 'checkout'; url: string }
  | { ok: true; kind: 'redeemed' }
  | { ok: false; kind: 'already_paid'; reportId: string }
  | { ok: false; kind: 'grade_not_done' }
  | { ok: false; kind: 'provider_outage' }   // NEW
  | { ok: false; kind: 'must_verify_email' }
  | { ok: false; kind: 'rate_limited'; retryAfter: number }
  | { ok: false; kind: 'unavailable' }
  | { ok: false; kind: 'unknown'; status: number }
```

In `postBillingCheckout`, inside the `res.status === 409` block, add before the final fallthrough:

```ts
if (body.error === 'provider_outage') return { ok: false, kind: 'provider_outage' }
```

- [ ] **Step 2: Update `RedeemResult` + parse**

Extend `RedeemResult`:

```ts
export type RedeemResult =
  | { ok: true }
  | { ok: false; kind: 'already_paid' | 'grade_not_done' | 'provider_outage' | 'no_credits' | 'must_verify_email' | 'unavailable' | 'unknown'; status?: number }
```

In `postBillingRedeemCredit`, inside the 409 block, add:

```ts
if (body.error === 'provider_outage') return { ok: false, kind: 'provider_outage' }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/lib/api.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): parse provider_outage from /billing/checkout + /billing/redeem-credit"
```

---

### Task 10: LiveGradePage renders outage message on `failedKind === 'provider_outage'`

**Files:**
- Modify: `src/web/pages/LiveGradePage.tsx`
- Test: `tests/unit/web/pages/LiveGradePage.failed.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/web/pages/LiveGradePage.failed.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

vi.mock('../../../../src/web/lib/api.ts', () => ({
  getGrade: vi.fn(async () => ({
    id: 'g1', url: 'https://x.test', domain: 'x.test',
    tier: 'free', status: 'failed', overall: null, letter: null,
    scores: null, createdAt: 't', updatedAt: 't',
  })),
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => ({ verified: false, email: null, credits: 0, refresh: async () => {}, logout: async () => {} }),
}))

function makeUseGradeEvents(failedKind: 'provider_outage' | 'other', error: string) {
  return () => ({
    state: {
      phase: 'failed' as const,
      scraped: null,
      probes: new Map(),
      categoryScores: { discoverability: null, recognition: null, accuracy: null, coverage: null, citation: null, seo: null },
      overall: null, letter: null, error, failedKind,
      paidStatus: 'none' as const, reportId: null, reportToken: null,
    },
    dispatch: vi.fn(),
    connected: true,
  })
}

describe('LiveGradePage failed states', () => {
  it('renders provider-outage copy when failedKind=provider_outage', async () => {
    vi.doMock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
      useGradeEvents: makeUseGradeEvents('provider_outage', 'Anthropic 500'),
    }))
    const { LiveGradePage: LiveGradePageIsolated } = await import('../../../../src/web/pages/LiveGradePage.tsx?isolated')
      .catch(async () => import('../../../../src/web/pages/LiveGradePage.tsx'))
    render(
      <MemoryRouter initialEntries={['/g/g1']}>
        <Routes><Route path="/g/:id" element={<LiveGradePageIsolated />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/llm provider outage/i)).toBeInTheDocument()
    expect(screen.getByText(/didn't count against your daily limit/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /try another url/i })).toBeInTheDocument()
  })

  it('renders generic error copy when failedKind=other', async () => {
    vi.doMock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
      useGradeEvents: makeUseGradeEvents('other', 'scrape too small'),
    }))
    render(
      <MemoryRouter initialEntries={['/g/g1']}>
        <Routes><Route path="/g/:id" element={<LiveGradePage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/scrape too small/i)).toBeInTheDocument()
  })
})
```

*If the dynamic import-isolation trick above is awkward for the codebase's existing test patterns, simplify: use one describe per failedKind, with the `vi.mock` call at module top — read the existing `LiveGradePage.url-header.test.tsx` for the established pattern and mirror it.*

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/web/pages/LiveGradePage.failed.test.tsx`
Expected: FAIL — copy not in the component yet.

- [ ] **Step 3: Update the failed-phase render in `LiveGradePage.tsx`**

Replace the existing block:

```tsx
if (state.phase === 'failed') {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">grade failed</div>
      <h2 className="text-xl text-[var(--color-warn)] mt-2 mb-4">{state.error ?? 'unknown error'}</h2>
      <Link to="/" className="text-[var(--color-brand)] underline">try another URL →</Link>
    </div>
  )
}
```

with:

```tsx
if (state.phase === 'failed') {
  const isOutage = state.failedKind === 'provider_outage'
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">
        {isOutage ? 'LLM provider outage' : 'grade failed'}
      </div>
      <h2 className="text-xl text-[var(--color-warn)] mt-2 mb-2">
        {isOutage
          ? "Claude or ChatGPT wasn't reachable."
          : state.error ?? 'unknown error'}
      </h2>
      {isOutage && (
        <p className="text-sm text-[var(--color-fg-dim)] mb-4">
          This grade didn't count against your daily limit. Give it a minute and try again.
        </p>
      )}
      <Link to="/" className="text-[var(--color-brand)] underline">try another URL →</Link>
    </div>
  )
}
```

- [ ] **Step 4: Run test + full suite**

Run: `pnpm test tests/unit/web/pages/LiveGradePage.failed.test.tsx && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/LiveGradePage.tsx tests/unit/web/pages/LiveGradePage.failed.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): LiveGradePage renders provider-outage copy on failedKind=provider_outage"
```

---

### Task 11: BuyReportButton handles `provider_outage` error + renders generating loader

**Files:**
- Modify: `src/web/components/BuyReportButton.tsx`
- Test: `tests/unit/web/components/BuyReportButton.test.tsx` (add cases; create if missing)

- [ ] **Step 1: Write the failing tests**

Open (or create) `tests/unit/web/components/BuyReportButton.test.tsx`. Add:

```tsx
it('renders "Generating your full report" after a successful credit redeem', async () => {
  vi.spyOn(api, 'postBillingRedeemCredit').mockResolvedValue({ ok: true })
  vi.spyOn(api, 'postBillingCheckout').mockImplementation(async () => { throw new Error('should not be called when credits > 0') })
  vi.mocked(useAuth).mockReturnValue({ verified: true, email: 'u@x', credits: 3, refresh: async () => {}, logout: async () => {} })
  render(<MemoryRouter><BuyReportButton gradeId="g1" onAlreadyPaid={() => {}} /></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /redeem 1 credit/i }))
  expect(await screen.findByText(/generating your full report/i)).toBeInTheDocument()
})

it('renders "Generating your full report" when checkout short-circuits with kind=redeemed', async () => {
  vi.spyOn(api, 'postBillingCheckout').mockResolvedValue({ ok: true, kind: 'redeemed' })
  vi.mocked(useAuth).mockReturnValue({ verified: true, email: 'u@x', credits: 0, refresh: async () => {}, logout: async () => {} })
  render(<MemoryRouter><BuyReportButton gradeId="g1" onAlreadyPaid={() => {}} /></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /get the full report/i }))
  expect(await screen.findByText(/generating your full report/i)).toBeInTheDocument()
})

it('renders provider_outage message when redeem returns provider_outage', async () => {
  vi.spyOn(api, 'postBillingRedeemCredit').mockResolvedValue({ ok: false, kind: 'provider_outage' })
  vi.mocked(useAuth).mockReturnValue({ verified: true, email: 'u@x', credits: 3, refresh: async () => {}, logout: async () => {} })
  render(<MemoryRouter><BuyReportButton gradeId="g1" onAlreadyPaid={() => {}} /></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /redeem 1 credit/i }))
  expect(await screen.findByText(/llm provider outage/i)).toBeInTheDocument()
  expect(screen.getByText(/start a new grade/i)).toBeInTheDocument()
})

it('renders provider_outage message when checkout returns provider_outage', async () => {
  vi.spyOn(api, 'postBillingCheckout').mockResolvedValue({ ok: false, kind: 'provider_outage' })
  vi.mocked(useAuth).mockReturnValue({ verified: true, email: 'u@x', credits: 0, refresh: async () => {}, logout: async () => {} })
  render(<MemoryRouter><BuyReportButton gradeId="g1" onAlreadyPaid={() => {}} /></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /get the full report/i }))
  expect(await screen.findByText(/llm provider outage/i)).toBeInTheDocument()
})
```

Top of file, make sure useAuth is importable from a mockable path. If the existing tests use `vi.mock('../../../../src/web/hooks/useAuth.ts', ...)`, follow that same pattern.

- [ ] **Step 2: Run test to verify failures**

Run: `pnpm test tests/unit/web/components/BuyReportButton.test.tsx`
Expected: FAIL — neither the generating state nor the provider_outage message exists.

- [ ] **Step 3: Update `BuyReportButton.tsx`**

Modify `src/web/components/BuyReportButton.tsx`:

1. Extend the `Mode` type:

```ts
type Mode = 'idle' | 'verify_email' | 'email_sent' | 'generating'
```

2. In `handleClick`, when the credit path succeeds (`result.ok`), set `mode = 'generating'` before `refresh`:

```ts
if (hasCredits) {
  const result = await postBillingRedeemCredit(gradeId)
  setPending(false)
  if (result.ok) {
    setMode('generating')
    await refresh()
    return
  }
  if (result.kind === 'already_paid') { onAlreadyPaid(gradeId); return }
  if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
  if (result.kind === 'provider_outage') {
    setError('LLM provider outage during grading. Start a new grade to unlock.')
    return
  }
  if (result.kind === 'no_credits') { setError('No credits available. Buy a pack below.'); return }
  if (result.kind === 'must_verify_email') { setError('Verify your email first.'); return }
  if (result.kind === 'unavailable') { setError('Checkout is temporarily unavailable.'); return }
  setError('Something went wrong. Try again?')
  return
}
```

3. In the checkout branch (after the hasCredits block), when `result.ok && result.kind === 'redeemed'`, also set `mode = 'generating'`:

```ts
const result = await postBillingCheckout(gradeId)
if (result.ok) {
  if (result.kind === 'checkout') { window.location.assign(result.url); return }
  // Server short-circuited to credit-redeem — stay on page, render generating loader.
  setMode('generating')
  await refresh()
  setPending(false)
  return
}
setPending(false)
if (result.kind === 'already_paid') { onAlreadyPaid(result.reportId); return }
if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
if (result.kind === 'provider_outage') {
  setError('LLM provider outage during grading. Start a new grade to unlock.')
  return
}
if (result.kind === 'must_verify_email') { setMode('verify_email'); return }
// ... (rest unchanged)
```

4. Add a render branch for `generating` before the email-verify render:

```tsx
if (mode === 'generating') {
  return (
    <div className="mt-6 border border-[var(--color-brand)] p-4">
      <div className="text-sm text-[var(--color-fg)] flex items-center gap-2">
        <span className="inline-block w-3 h-3 rounded-full bg-[var(--color-brand)] animate-pulse" />
        Generating your full report — usually 30-60 seconds.
      </div>
    </div>
  )
}
```

5. When rendering the error section at the bottom, make `provider_outage` a heading + subtext for visibility. The simplest path: special-case the error display right before the final return:

```tsx
if (error !== null && error.startsWith('LLM provider outage')) {
  return (
    <div className="mt-6 border border-[var(--color-warn)] p-4">
      <div className="text-sm text-[var(--color-warn)] font-semibold mb-1">LLM provider outage</div>
      <div className="text-xs text-[var(--color-fg-dim)]">Start a new grade to unlock the full report.</div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/web/components/BuyReportButton.test.tsx`
Expected: PASS (all 4 new + existing).

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/BuyReportButton.tsx tests/unit/web/components/BuyReportButton.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): BuyReportButton shows generating loader + provider_outage error"
```

---

### Task 12: Hide BuyReportButton when `paidStatus === 'generating'` in LiveGradePage

**Files:**
- Modify: `src/web/pages/LiveGradePage.tsx`
- Test: `tests/unit/web/pages/LiveGradePage.generating.test.tsx` (new)

**Why:** Task 11 covers the client-optimistic case (user just clicked redeem). This task covers the page-refresh-during-generation case: SSE `report.started` has fired, reducer is at `paidStatus: 'generating'`, user refreshes — LiveGradePage should render `<PaidReportStatus />` instead of the button. Today `isFreeTierDone = state.phase === 'done' && effectivePaidStatus === 'none'` already guards `BuyReportButton`, so the work here is mostly test coverage + any edge case cleanup.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/web/pages/LiveGradePage.generating.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

vi.mock('../../../../src/web/lib/api.ts', () => ({
  getGrade: vi.fn(async () => ({
    id: 'g1', url: 'https://x', domain: 'x',
    tier: 'paid', status: 'done', overall: 80, letter: 'B',
    scores: {}, createdAt: 't', updatedAt: 't',
  })),
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => ({ verified: true, email: 'u@x', credits: 2, refresh: async () => {}, logout: async () => {} }),
}))

vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: () => ({
    state: {
      phase: 'done' as const,
      scraped: null,
      probes: new Map(),
      categoryScores: { discoverability: 80, recognition: 80, accuracy: 80, coverage: 80, citation: 80, seo: 80 },
      overall: 80, letter: 'B', error: null, failedKind: null,
      paidStatus: 'generating' as const, reportId: null, reportToken: null,
    },
    dispatch: vi.fn(),
    connected: true,
  }),
}))

describe('LiveGradePage during paid report generation', () => {
  it('does NOT render the BuyReportButton when paidStatus=generating', async () => {
    render(
      <MemoryRouter initialEntries={['/g/g1']}>
        <Routes><Route path="/g/:id" element={<LiveGradePage />} /></Routes>
      </MemoryRouter>,
    )
    // BuyReportButton's CTA text should be absent
    expect(screen.queryByRole('button', { name: /redeem 1 credit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get the full report/i })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it passes out of the box OR fails**

Run: `pnpm test tests/unit/web/pages/LiveGradePage.generating.test.tsx`

If it PASSES: `isFreeTierDone` already excludes this case because `effectivePaidStatus !== 'none'` when `paidStatus === 'generating'`. Confirm by reading the LiveGradePage logic. Still write the test (regression guard) and proceed to commit.

If it FAILS: add a stricter guard to the `isFreeTierDone` line in `src/web/pages/LiveGradePage.tsx`:

```tsx
const isFreeTierDone = state.phase === 'done' && effectivePaidStatus === 'none'
```

…and verify it covers all generating/ready/failed states. The existing line should already do this. If something slipped, fix it.

- [ ] **Step 3: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/LiveGradePage.tsx tests/unit/web/pages/LiveGradePage.generating.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(web): regression guard — BuyReportButton hidden when paidStatus=generating"
```

---

## Self-review checklist (controller runs this)

**1. Spec coverage:**
- §3.1 Worker canary halt → Task 5 ✓
- §3.2 Bucket refund plumbing → Task 1 ✓ (addToBucket + removeFromBucket + peek/commit split)
- §3.3 Paid-flow gate → Tasks 7 (redeem) + 8 (checkout) ✓
- §3.4 SSE event kind → Task 4 ✓
- §3.5 Frontend outage message → Task 10 ✓
- §3.6 Frontend provider_outage parse → Tasks 9 + 11 ✓
- §3.7 Generating-report loader → Tasks 11 (component) + 12 (page guard) ✓
- P12-6 Rate-limit refund gradeId correlation → Task 1 ✓
- P12-7 hasTerminalProviderFailures (no new columns) → Task 3 ✓
- P12-8 SSE event kind union → Task 4 ✓
- P12-9 HTTP 409 provider_outage → Tasks 7 + 8 + 9 ✓
- GradeJob payload extension → Task 2 ✓

**2. Placeholder scan:** No TBD / TODO / "similar to Task N" anywhere. All code shown inline.

**3. Type consistency:**
- `GradeEvent` `{ type: 'failed'; kind: ...; error: string }` — declared Task 4, consumed Task 5 (halt path) + Task 5 catch block + Task 10 (reducer test).
- `GradeState.failedKind` — declared Task 4, consumed Task 10 render branch.
- `hasTerminalProviderFailures(gradeId)` — declared Task 3 Step 1, implemented Task 3 Step 4 + Step 5 (fake), consumed Task 5 (outage-detect.ts), Task 7, Task 8.
- `CheckoutResult` / `RedeemResult` `provider_outage` kind — declared Task 9, consumed Task 11.
- `GradeJob.ip` / `GradeJob.cookie` — declared Task 2, consumed Task 1 Step 6 (enqueue) + Task 5 (worker).
- `peekRateLimit` / `commitRateLimit` / `refundRateLimit` — declared Task 1, consumed Task 1 grades.ts + Task 5 worker + Task 6 integration test.
- `gradeBucketMember(gradeId) = 'grade:${gradeId}'` — declared Task 1, consumed implicitly by commit + refund.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-04-20-geo-reporter-plan-12-provider-outage-halt.md` (within the `feature/plan-12` worktree).

**Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review after each.
**2. Inline Execution** — batch through with checkpoints in this session.

Which approach?
