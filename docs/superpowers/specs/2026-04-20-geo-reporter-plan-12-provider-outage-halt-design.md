# Plan 12 — Provider-outage halt & gate design

**Date:** 2026-04-20
**Status:** Draft — awaiting user review before plan
**Author:** Claude + Erika

---

## 1. Problem

Today, if Claude or OpenAI has a terminal outage during a free grade, the pipeline still produces a grade (with `score: null` on the affected probes) and marks it `status: 'done'`. The user then sees a partial grade and a "get the full report" CTA. If they click redeem/checkout, a credit (or $19) is spent on a doomed report — the paid flow runs Gemini + Perplexity delta probes on top of a half-broken foundation.

The user wants two gates:

- **Free grade gate:** if Claude *or* OpenAI's core probe returns a terminal error (after OpenRouter fallback exhausted), halt the grade, refund the rate-limit bucket slot, show a clean "try again" page.
- **Paid unlock gate:** `/billing/redeem-credit` and `/billing/checkout` must refuse a grade whose Claude-or-OpenAI probes terminally failed, *before* consuming a credit or creating a Stripe session.

## 2. Decisions (locked)

| ID    | Decision |
|-------|----------|
| P12-1 | **"Failed" = any single Claude or OpenAI probe returns a terminal error after OpenRouter fallback exhausts.** Flakes are already absorbed by fallback; a terminal error means the provider is genuinely unreachable. |
| P12-2 | **Halt trigger = discoverability probe.** Discoverability becomes the canary — it runs first (sequentially), before the rest of the categories fan out. ~5-10s to fail-fast instead of ~30s. |
| P12-3 | **Retry UX = redirect-to-landing link.** Failed page shows "← try another URL" — matches today's failed-grade UX. No inline retry button. |
| P12-4 | **Only Claude + OpenAI gate the halt.** Gemini / Perplexity failures are logged but don't halt (those are paid-tier additions, already handled by `score: null` collapsing). |
| P12-5 | **Pre-consumption rejection in paid flow, no refund path.** `/redeem-credit` and `/checkout` check grade health before decrementing credits or creating Stripe sessions. No Stripe refund logic is added — if the gate works, we never reach the consumption step. |
| P12-6 | **Rate-limit refund by correlating bucket member with gradeId.** Today `addToBucket` stores `${now}-${uuid}` — change to `${now}-${gradeId}` so the worker can `zrem` the exact slot on halt. |
| P12-7 | **No new DB columns.** Paid-flow rejection derives from `probes` table — count rows where `provider ∈ {claude, openai}` AND `score IS NULL` AND `metadata.error` is set. |
| P12-8 | **New SSE event kind.** `{ type: 'failed', kind: 'provider_outage' | 'other', error: string }`. Frontend branches on `kind` to render the right message. Existing callers default to `kind: 'other'`. |
| P12-9 | **New HTTP error kind on billing endpoints.** `409 { error: 'provider_outage' }` from `/billing/redeem-credit` and `/billing/checkout`. Frontend `BuyReportButton` renders inline. |

## 3. Architecture

### 3.1 Worker changes — `src/queue/workers/run-grade/run-grade.ts`

Current shape:
```ts
// SEO first (sync, instant), then 5 LLM categories in parallel
const seoScore = await runSeoCategory(...)
const [rec, cit, disc, cov, acc] = await Promise.all([
  runRecognitionCategory(...), runCitationCategory(...),
  runDiscoverabilityCategory(...), runCoverageCategory(...), runAccuracyCategory(...),
])
```

New shape:
```ts
// SEO first (sync), then discoverability as canary, then the rest in parallel.
const seoScore = await runSeoCategory(...)

const discScore = await runDiscoverabilityCategory({ ..., probers, deps })
const outage = await detectClaudeOrOpenAIOutage(gradeId, deps.store)
if (outage) {
  await refundRateLimitBucket(deps.redis, { ip: job.data.ip, cookie: job.data.cookie, gradeId })
  await deps.store.updateGrade(gradeId, { status: 'failed' })
  await publishGradeEvent(deps.redis, gradeId, {
    type: 'failed', kind: 'provider_outage', error: outage.message,
  })
  return  // graceful exit — job does NOT throw (we don't want BullMQ retries)
}

const [rec, cit, cov, acc] = await Promise.all([
  runRecognitionCategory(...), runCitationCategory(...),
  runCoverageCategory(...), runAccuracyCategory(...),
])
```

**`detectClaudeOrOpenAIOutage(gradeId, store)`** — thin wrapper around `GradeStore.hasTerminalProviderFailures(gradeId)`. Same SQL used by the paid-flow gate (§3.3) — single source of truth. At canary time only discoverability rows exist, so the check answers "did Claude or OpenAI terminal-fail on discoverability?"; at paid-gate time more probes exist, so the same check answers "did Claude or OpenAI terminal-fail on any probe?". Consistent semantics, same query.

### 3.2 Rate-limit bucket correlation — `src/server/middleware/bucket.ts`

Change the `addToBucket` signature to accept a correlatable member string:

```ts
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

Caller (`checkRateLimit` in `rate-limit.ts`) now mints `${now}-${gradeId}`. But wait — `checkRateLimit` runs *before* grade creation, so gradeId isn't known yet.

**Resolution:** split the rate limit into two steps:
1. `peekRateLimit(...)` — returns allowed/denied + retry-after. Runs in middleware today.
2. `commitRateLimit(..., gradeId)` — actually adds to the bucket. Runs after grade row is created.

Routes that create grades (`POST /grades`) call both. This is a small refactor of `src/server/routes/grades.ts`.

The worker's halt path imports `removeFromBucket` and calls it with the matching member.

**Worker needs ip + cookie.** Add `ip` and `cookie` to the `GradeJob` payload (already has `gradeId` and `tier`). The `POST /grades` route already knows both from `c.var`.

### 3.3 Paid-flow gate — `src/server/routes/billing.ts`

Add a helper `hasClaudeOrOpenAIOutage(store, gradeId): Promise<boolean>` that runs:

```sql
SELECT 1 FROM probes
WHERE grade_id = $1
  AND provider IN ('claude', 'openai')
  AND score IS NULL
  AND metadata->>'error' IS NOT NULL
LIMIT 1
```

Returns true if any row matches. This goes in `GradeStore.hasTerminalProviderFailures(gradeId)` — the store is the seam for DB access.

Call site — inside both `/billing/redeem-credit` and `/billing/checkout`, *before* the credit decrement / Stripe session creation. After the existing `grade_not_done` check, before the existing `already_paid` check:

```ts
if (await deps.store.hasTerminalProviderFailures(grade.id)) {
  return c.json({ error: 'provider_outage' }, 409)
}
```

This means a grade that was `status: 'done'` *but* had provider outages on Gemini / Perplexity during the paid flow's delta probes will NOT trigger this gate — the gate is specifically for failures recorded during the free grade (Claude + OpenAI only, which only run during the free grade). This matches P12-4.

### 3.4 SSE event — `src/queue/events.ts`

Extend the `failed` event variant:

```ts
type GradeEvent =
  | ...
  | { type: 'failed'; kind: 'provider_outage' | 'other'; error: string }
```

Update every site that publishes `type: 'failed'`:
- `src/queue/workers/run-grade/run-grade.ts` catch block → `kind: 'other'`
- New halt path in canary → `kind: 'provider_outage'`

### 3.5 Frontend — `src/web/pages/LiveGradePage.tsx`

Reducer update — `src/web/lib/grade-reducer.ts` adds a `failedKind` field to state:

```ts
interface State {
  ...
  phase: 'idle' | 'scraping' | 'running' | 'done' | 'failed'
  error: string | null
  failedKind: 'provider_outage' | 'other' | null
}
```

Render branch in LiveGradePage when `phase === 'failed'`:
```tsx
{state.phase === 'failed' && (
  <div className="...">
    <h2>{state.failedKind === 'provider_outage' ? 'LLM provider outage' : 'Something went wrong'}</h2>
    <p>
      {state.failedKind === 'provider_outage'
        ? "Claude or ChatGPT wasn't reachable. This grade didn't count against your daily limit. Give it a minute and try again."
        : state.error ?? 'unknown error'}
    </p>
    <Link to="/" className="...">← try another URL</Link>
  </div>
)}
```

### 3.6 Frontend — `src/web/components/BuyReportButton.tsx`

Extend the result union in both `postBillingCheckout` and `postBillingRedeemCredit`:

```ts
type Result =
  | ...
  | { ok: false; kind: 'provider_outage' }
```

In the button handler, surface:
```tsx
if (result.kind === 'provider_outage') {
  setError('This grade had an LLM provider outage. Start a new grade to unlock.')
  return
}
```

### 3.7 Frontend — "Generating report..." loading state in the button slot

**Problem:** when the user successfully redeems a credit (or completes Stripe checkout), the generate-report worker kicks off asynchronously. There's a gap between the redeem returning 200 and the first `report.started` SSE event arriving. Today the `BuyReportButton` stays mounted during that gap — the user sees the same "Redeem 1 credit" button they just clicked.

**Fix:** after a successful redeem/checkout, the button slot renders a loading block instead of the button. Two sources drive this:

1. **Optimistic (client-side)** — `BuyReportButton` internal state: after `postBillingRedeemCredit` returns `ok`, set `mode = 'generating'`. Component returns the loading UI instead of the button form.
2. **Authoritative (reducer)** — `state.paidStatus === 'generating'` (from `report.started` SSE) already triggers `<PaidReportStatus />` to render elsewhere. When paidStatus hits `'generating' | 'ready' | 'failed'`, LiveGradePage unmounts `BuyReportButton` entirely (today it already does this for `ready`; we extend to `generating`).

**Loading UI shape in BuyReportButton:**
```tsx
if (mode === 'generating' || paidStatus === 'generating') {
  return (
    <div className="mt-6 border border-[var(--color-brand)] p-4">
      <div className="text-sm text-[var(--color-fg)] flex items-center gap-2">
        <Spinner />
        Generating your full report — this usually takes 30-60 seconds.
      </div>
    </div>
  )
}
```

**Why both sources:**
- The optimistic one covers the gap between redeem 200 and the first SSE event (~1-3s where the job is queued but not yet started).
- The authoritative one handles page refresh mid-generation: if the user refreshes while a report is generating, the server's `/grades/:id` hydrate response carries `paidStatus: 'generating'` (already wired in Plan 9), and LiveGradePage should render the loading state, not the button.

**Paid checkout (Stripe) path:** same mechanic. When `postBillingCheckout` returns `{ ok: true, kind: 'redeemed' }` (the server-side redeem short-circuit from Plan 10), set `mode = 'generating'`. When it returns `{ ok: true, kind: 'checkout', url }`, redirect to Stripe as today — after Stripe success the user lands back on the grade page with `?checkout=complete`, and LiveGradePage's existing `effectivePaidStatus: 'checking_out'` branch already covers that case.

**Files touched here:** `src/web/components/BuyReportButton.tsx` (add `mode === 'generating'` branch + new render), `src/web/pages/LiveGradePage.tsx` (extend the condition that unmounts `BuyReportButton` to include `paidStatus === 'generating'`).

## 4. Data flow

### Free grade — happy path (no change)
```
POST /grades → peekRateLimit → insert grade → commitRateLimit(gradeId)
             → enqueue grade job with { gradeId, tier, ip, cookie }
Worker: updateGrade(running) → scrape → SEO → discoverability (canary)
       → detectClaudeOrOpenAIOutage → null → parallel Promise.all → done
```

### Free grade — Claude or OpenAI terminal failure
```
POST /grades → peekRateLimit → insert grade → commitRateLimit(gradeId)
             → enqueue grade job
Worker: updateGrade(running) → scrape → SEO → discoverability (canary)
       → detectClaudeOrOpenAIOutage → { message }
       → removeFromBucket(ip, cookie, gradeId)  // refund
       → updateGrade(failed)
       → publishGradeEvent({ type: 'failed', kind: 'provider_outage', error })
       → return (no throw — BullMQ marks job complete)
SSE: LiveGradePage renders "LLM provider outage" page with back link.
```

### Paid unlock blocked by prior outage
```
POST /billing/redeem-credit { gradeId }
  → validate cookie + grade ownership
  → if grade.status !== 'done' → 409 grade_not_done
  → if hasTerminalProviderFailures(gradeId) → 409 provider_outage  // NEW
  → if hasPaidPayment(gradeId) → 409 already_paid
  → decrement credit (unchanged)
```

## 5. Testing

Unit:
- `runGrade` halts cleanly when mock providers throw terminal errors on discoverability
- `runGrade` does NOT halt when only Gemini/Perplexity fail
- `detectClaudeOrOpenAIOutage` logic — probe matrix covering all combinations
- `/billing/redeem-credit` returns 409 `provider_outage` when probes have Claude or OpenAI terminal rows; no credit decrement
- `/billing/checkout` returns 409 `provider_outage` under same conditions; no Stripe session
- `BuyReportButton` renders the provider_outage message on 409
- `BuyReportButton` renders "Generating report..." loader after successful redeem
- `LiveGradePage` unmounts `BuyReportButton` and renders the loader when `paidStatus === 'generating'` (covers page refresh mid-generation)
- `LiveGradePage` renders the outage message when SSE delivers `failed` + `provider_outage`
- Bucket refund: member is correlated by gradeId; `removeFromBucket` with matching member decrements count

Integration:
- `POST /grades` flow hits Postgres + Redis via testcontainers, creates grade, commits bucket slot; worker halt path refunds it (bucket count returns to pre-submit level)
- End-to-end: anon user submits → worker halts → subsequent `POST /grades` from same cookie is allowed (confirms bucket was actually refunded, not just zeroed)

## 6. Out of scope

- Stripe $19 refunds — no post-consumption refund path. The gate catches it before consumption.
- Retroactive handling: grades that already completed with Claude/OpenAI probe failures pre-Plan-12 will now be blocked from paid unlock. This is correct behavior (they're broken grades) but acknowledge it's a behavior change for existing rows.
- Gemini / Perplexity outage halt — not requested. Those providers only run in paid flow, where we've already consumed the credit by the time they run. Separate feature if needed.
- Auto-retry on the failed page — explicitly rejected per P12-3.
- Provider-outage alerting / circuit breaker — future work if outages become common.

## 7. Files touched

**Modify:**
- `src/queue/workers/run-grade/run-grade.ts` — canary step + halt path
- `src/queue/workers/run-grade/deps.ts` — add redis to deps if not already (for refund)
- `src/queue/queues.ts` — extend `GradeJob` with `ip`, `cookie`
- `src/queue/events.ts` — extend failed event with `kind`
- `src/server/middleware/bucket.ts` — `addToBucket(member)` signature, new `removeFromBucket`
- `src/server/middleware/rate-limit.ts` — split into `peekRateLimit` + `commitRateLimit`
- `src/server/routes/grades.ts` — call split rate-limit API; pass ip+cookie into job payload
- `src/server/routes/billing.ts` — `provider_outage` gate in `/redeem-credit` and `/checkout`
- `src/store/types.ts` — add `hasTerminalProviderFailures` to `GradeStore`
- `src/store/postgres.ts` — implement it
- `tests/unit/_helpers/fake-store.ts` — implement for fake
- `src/web/lib/api.ts` — extend `checkout` / `redeem` result unions
- `src/web/lib/grade-reducer.ts` — `failedKind` state field
- `src/web/pages/LiveGradePage.tsx` — render outage branch
- `src/web/components/BuyReportButton.tsx` — handle `provider_outage` result

**Create:**
- `src/queue/workers/run-grade/outage-detect.ts` — `detectClaudeOrOpenAIOutage` function (small, pure, easy to unit-test)
- `tests/unit/queue/workers/run-grade/outage-detect.test.ts`
- `tests/unit/queue/workers/run-grade/run-grade.halt.test.ts`
- `tests/unit/server/routes/billing-provider-outage.test.ts`
- `tests/integration/rate-limit-refund.test.ts`

## 8. Risks & open questions

- **Discoverability serialized before the rest:** +5-10s to happy-path wall time on the free grade. Acceptable given the free grade today is already ~30s. If this becomes a problem, we can run canary (discoverability) in parallel with the rest and rely on cancellation — but cancellation in JS/BullMQ is ugly.
- **`removeFromBucket` is eventually consistent:** if two grades land in the same second from the same cookie, the specific-member removal still works because each member has a unique `${now}-${gradeId}` suffix. Good.
- **Existing data:** grades created before this plan have Claude/OpenAI probes with `score IS NULL` and an error in metadata — those WILL now be blocked from paid unlock. Counts as a migration moment, not a bug.
