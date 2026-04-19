# GEO Reporter — Plan 8 (Stripe paywall + generate-report) design

> Sub-spec for Plan 8. Expands master spec §4.3 (trace step 5), §7.3 (paid tier), §8.4 (recommendation LLM), §10 (API surface rows for `/billing/*`). Brainstormed 2026-04-19. Plan 8 wires Stripe Checkout end-to-end, runs the delta-probe + recommendation pipeline, and persists the `reports` row. Rendering of `/report/:id` is Plan 9's job.

## 1. Scope

When a free-tier grade completes, the user sees a "Get the full report — $19" button. Clicking it creates a Stripe Checkout session, redirects to the Stripe-hosted form, and (on success) routes back to the LiveGradePage with a `?checkout=complete` marker. Stripe's webhook tells us payment completed; we enqueue a `generate-report` job that runs the two paid-tier providers (Gemini + Perplexity), recomputes composite scores, runs the recommendation LLM, and writes a `reports` row with a random-token capability. The LiveGradePage watches SSE and flips to a "report ready" state when done.

**In scope**
- `POST /billing/checkout` — server route that creates (or resumes) a Stripe Checkout Session.
- `POST /billing/webhook` — Stripe webhook receiver, verifies signature, enqueues `generate-report`.
- `src/billing/` — Stripe SDK wrapper (one file, two methods: `createCheckoutSession`, `verifyWebhookSignature`).
- `generate-report` BullMQ worker — delta probes + composite rescore + recommendation LLM + `reports` row + `tier='paid'`.
- New SSE event types on the existing `grade:<id>` channel: `report.started`, `report.probe.started`, `report.probe.completed`, `report.recommendations.started`, `report.recommendations.completed`, `report.done`, `report.failed`.
- Plan 6a's SSE endpoint extended to hydrate paid-tier probes from the DB on reconnect.
- LiveGradePage state machine: six states covering free-done, checkout-complete, generating, ready, failed, canceled.
- `FakeStripe` test helper + `stripe` runtime dep + new env vars (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`).

**Out of scope**
- `/report/:id` route + HTML/PDF rendering — Plan 9.
- Admin dashboard for failed-payment reconciliation — deferred.
- Automatic refunds on `generate-report` failure — deferred (manual refund via Stripe admin for MVP).
- `/my/grades` listing — separate follow-up plan.
- Real Stripe end-to-end smoke test — Plan 10 deploy verification.
- Rate limit on `/billing/checkout` — deferred (bounded attack surface; see production-checklist).
- Purchase-receipt emails — needs real Mailer (Plan 10).

## 2. Decisions locked in on 2026-04-19

| # | Decision | Choice | Why |
|---|---|---|---|
| P8-1 | Plan 8 vs Plan 9 scope | Plan 8 ships through "recommendations + token persisted, `tier='paid'`"; Plan 9 renders `/report/:id` | Clean handoff. Plan 8 doesn't half-render a report. LiveGradePage's "view your report" link gets a "coming in Plan 9" note that swaps out when Plan 9 ships. |
| P8-2 | `generate-report` pipeline shape | Delta: run only Gemini + Perplexity probes, recompute composite scores, run recommendation LLM | Matches master spec §4.3 step 5 verbatim. Doesn't burn Claude/GPT tokens twice. |
| P8-3 | `/billing/checkout` guards | Two guards: 409 on already-paid; resume existing pending session if one exists; else new session | Clean UX (user resumes same Stripe page if they abandoned). No orphan-row proliferation. |
| P8-4 | Generate-report failure handling | Mark grade with error flag; manual Stripe refund. Auto-refund goes on production checklist | MVP simplicity. Refunds rare; manual handling tolerable until we see real traffic. |
| P8-5 | SSE events for report progress | Reuse `grade:<id>` channel with new `report.*` event types | Infrastructure already per-grade. Frontend reuses existing `useGradeEvents` hook. |
| P8-6 | Testing Stripe interactions | Mock Stripe SDK + locally construct signed webhook events | Matches LLM-provider testing pattern (MockProvider for unit, real keys gated for CI). Stripe SDK has first-class support for constructing signed events. |
| P8-7 | SSE event granularity | Full — per-probe events for Gemini/Perplexity + recommendation LLM events | Paid users should get at least as much visibility as free users. Publish-events pattern already exists in `run-grade`. |

## 3. Architecture

```
src/server/
├── app.ts                                MODIFY — mount /billing sub-app (webhook route bypasses cookie middleware)
├── deps.ts                               MODIFY — add billing: BillingClient, reportQueue: Queue to ServerDeps
├── server.ts                             MODIFY — instantiate BillingClient + reportQueue
└── routes/
    └── billing.ts                        NEW — POST /checkout (cookie-owned), POST /webhook (signature-auth)

src/billing/
├── types.ts                              NEW — BillingClient interface + session types
├── stripe-client.ts                      NEW — Stripe SDK wrapper implementing BillingClient
└── prices.ts                             NEW — PRICE_ID resolver (from env) + amountCents constant

src/queue/
├── queues.ts                             MODIFY — add reportQueueName + factory
└── workers/generate-report/
    ├── index.ts                          NEW — registerGenerateReportWorker (factory + BullMQ wiring)
    ├── deps.ts                           NEW — GenerateReportDeps interface (store, publishGradeEvent, providers, judge, recommenderClient)
    ├── generate-report.ts                NEW — the Processor function: delta probes → rescore → recommendations → reports row → tier='paid'
    └── recommender.ts                    NEW — single-call LLM flow: build prompt, call provider, parse+validate JSON, retry once with stricter prompt

src/scoring/
└── composite.ts                          MODIFY — expose a rescore helper that recomputes from existing probe rows (pure function; currently tied to run-grade's in-memory state)

src/llm/prompts.ts                        MODIFY — add buildRecommenderPrompt(inputs)

src/web/
├── lib/
│   ├── api.ts                            MODIFY — postBillingCheckout(gradeId) wrapper
│   └── types.ts                          MODIFY — GradeEvent union extended with report.* variants; paidState shape
├── hooks/
│   └── useGradeEvents.ts                 MODIFY — reducer extended to handle report.* events; derive a paidStatus: 'none' | 'checking_out' | 'generating' | 'ready' | 'failed'
├── components/
│   ├── BuyReportButton.tsx               NEW — "Get the full report — $19" CTA; handles click → postBillingCheckout → redirect
│   ├── PaidReportStatus.tsx              NEW — banner + spinner + "view report" link, driven by paidStatus
│   └── CheckoutCanceledToast.tsx         NEW — small toast when ?checkout=canceled is in the URL (Plan 7 Toast component reused where possible)
└── pages/
    └── LiveGradePage.tsx                 MODIFY — compose BuyReportButton + PaidReportStatus; read ?checkout=... params; strip on mount

tests/unit/
├── _helpers/fake-stripe.ts               NEW — in-memory BillingClient with sessions.create + session.retrieve stubs, constructs signed events for webhook tests
├── _helpers/fake-recommender.ts          NEW — deterministic fake for the recommendation LLM (returns a fixed array by default; overridable for retry-path tests)
├── server/routes/billing-checkout.test.ts NEW — ~8 cases
├── server/routes/billing-webhook.test.ts  NEW — ~6 cases
├── queue/workers/generate-report.test.ts NEW — ~10 cases (delta probe, rescore, LLM retry, tier='paid' last, failure modes)
├── scoring/composite-rescore.test.ts     NEW — rescore helper unit tests
└── web/
    ├── components/BuyReportButton.test.tsx NEW
    ├── components/PaidReportStatus.test.tsx NEW
    └── pages/LiveGradePage.test.tsx      MODIFY — add cases for checkout=complete / =canceled / paid-done / report.failed

tests/integration/
├── billing-webhook.test.ts               NEW — construct + sign real Stripe events, POST to /billing/webhook, assert DB + enqueue
└── generate-report-lifecycle.test.ts     NEW — end-to-end: free grade done → enqueue generate-report → watch DB transition → assert reports row + tier='paid'

docs/production-checklist.md              MODIFY — add 4 new deferred items

docs/superpowers/specs/
└── 2026-04-17-geo-reporter-design.md     MODIFY — anchor paragraph under §7.3 pointing at this sub-spec
```

## 4. Endpoints

### 4.1 `POST /billing/checkout`

Cookie-authenticated (reuses `cookieMiddleware` + `clientIp`, does NOT apply grade rate-limit).

**Request body:** `{ gradeId: string }` (validated via Zod — UUIDv4 shape).

**Flow:**

1. Load `grades` row by `gradeId`. If missing → 404. If `grades.cookie !== c.var.cookie` → 404 (privacy, don't signal existence to non-owners).
2. If `grades.status !== 'done'` → `409 { error: 'grade_not_done' }`.
3. Query existing `stripe_payments` rows for this grade:
   - If any row has `status='paid'` → `409 { error: 'already_paid', reportId: grade.id }`. Frontend links to report.
   - If a row has `status='pending'` AND the Stripe session is still open (query Stripe: `sessions.retrieve(sessionId).status === 'open'`) → return `{ url: existingSession.url }`. User resumes.
   - If a row has `status='pending'` but Stripe session is `'expired'` or `'complete'` (with payment_status `unpaid`) → soft-mark the row as `status='failed'` (no new column needed; use the existing `failed` enum value); fall through to create a new session.
   - Else → create a new session.
4. Create Stripe Checkout Session via `billing.createCheckoutSession({ gradeId, successUrl, cancelUrl })`:
   - `mode: 'payment'` (NOT subscription)
   - Single line item: `{ price: env.STRIPE_PRICE_ID, quantity: 1 }`
   - `metadata: { gradeId }` (Stripe guarantees this round-trips)
   - `success_url: ${env.PUBLIC_BASE_URL}/g/${gradeId}?checkout=complete`
   - `cancel_url: ${env.PUBLIC_BASE_URL}/g/${gradeId}?checkout=canceled`
   - `client_reference_id: gradeId` (belt-and-suspenders; easier log inspection)
5. Insert `stripe_payments` row with `{ gradeId, sessionId: session.id, status: 'pending', amountCents: 1900, currency: 'usd' }`.
6. Return `{ url: session.url }`.

**Returns:** `200 { url }` or `404` or `409 { error, reportId? }` or `500` on unexpected errors.

### 4.2 `POST /billing/webhook`

Mounted OUTSIDE the cookie/auth sub-apps — Stripe doesn't send our cookies. Authentication is the `Stripe-Signature` header.

**Critical:** needs the raw request body for signature verification. Hono gets this via `await c.req.raw.arrayBuffer()` — do NOT call `c.req.json()` first (that would consume/reparse the stream).

**Flow:**

1. Grab raw body bytes + `Stripe-Signature` header.
2. `billing.verifyWebhookSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)`. Returns the parsed `event` object or throws. On throw → `400` (no body logged — could leak customer data if signature forgery was attempted with real-looking data).
3. Branch on `event.type`:
   - `checkout.session.completed` → proceed to step 4.
   - Anything else → `200` with an empty body (we ACK; Stripe stops retrying anything 2xx).
4. Extract `gradeId` from `event.data.object.metadata.gradeId` (validate UUID shape; missing → 400).
5. Idempotency: load `stripe_payments` WHERE `session_id = event.data.object.id`.
   - If row missing → 400 (unexpected: we should have inserted it on `/checkout`, so Stripe webhook arriving for a session we don't know about means tampering or a race — fail loud).
   - If row exists with `status='paid'` → 200 no-op (Stripe is retrying; we've already handled it).
   - Else → update `status='paid'`, `amountCents = event.data.object.amount_total`, `currency = event.data.object.currency`, `updatedAt = now()`.
6. Enqueue `generate-report` job: `reportQueue.add('generate-report', { gradeId, sessionId }, { jobId: `generate-report:${sessionId}` })`. The deterministic `jobId` is a BullMQ-level idempotency guard — if two webhook retries somehow both pass step 5 (race window), BullMQ dedupes the second enqueue.
7. Return `200`.

**Returns:** `200` on success or already-handled; `400` on signature / missing metadata / unknown session; `500` on unexpected.

## 5. `generate-report` worker

**File:** `src/queue/workers/generate-report/generate-report.ts`.

**Deps (`GenerateReportDeps`):**

```
- store: GradeStore
- publishGradeEvent(gradeId, event): publishes to Redis grade:<id> channel
- providers: Record<'claude' | 'gpt' | 'gemini' | 'perplexity', Provider>
- judge: JudgeFn
- recommender: RecommenderFn (wraps a provider; defaults to Claude)
- logger: pino-style
```

**Job input:** `{ gradeId, sessionId }`.

**Processor flow:**

1. Publish `{ type: 'report.started', gradeId }`.
2. Load grade + scrape + existing probe rows. Assert `grade.tier === 'free'` and `grade.status === 'done'`. If not, throw (BullMQ won't retry idempotency violations; the row is already set up for manual review).
3. Build ground truth from scrape (reuse `src/llm/ground-truth.ts`).
4. **Delta probes** — for each of the two paid-tier providers (Gemini + Perplexity):
   - Run `runStaticProbe(provider, promptRecognition)` → publish `report.probe.started` with `{ provider, category: 'recognition', label: 'description' }`, await result, persist probe row, publish `report.probe.completed` with score + response.
   - Run `runCoverageFlow` for each of the 4 coverage queries.
   - Run `runStaticProbe(provider, promptCitation)` for each of the 2 citation queries.
   - Run `runStaticProbe(provider, promptDiscoverability)` for each of the 2 discoverability queries.
   - Run accuracy prober + verifier just for this provider (reuse `runAccuracyForProvider` pattern from Plan 5; generator stays Claude-only). Persist the accuracy probe + verify rows.
5. **Recompute composite.** Load all probe rows for the grade (now 4 providers × all categories). Call the rescore helper (new in `src/scoring/composite.ts`) with the full probe list; it returns `{ overall, letter, scores }`. Update `grades.overall` / `grades.letter` / `grades.scores`.
6. Publish `report.recommendations.started`.
7. **Recommendation LLM:**
   - Build input blob: `{ url, scores, failingSeoSignals (from probes.category='seo' WHERE score !== 100), accuracyQuestion (from probes.category='accuracy' provider=null), accuracyAnswers (from probes.category='accuracy' provider != null), llmDescriptions (from probes.category='recognition'), scrapeText (first 4000 chars) }`.
   - Call `recommender.generate(input)`. Returns parsed/validated `Recommendation[]` (Zod-validated — `{ title, category, impact: 1..5, effort: 1..5, rationale, how }`).
   - If parse fails or `result.length < 5`, retry once with a stricter prompt appended ("Return AT LEAST 5 recommendations as valid JSON matching this exact schema: …").
   - If still failing: persist `[]` and set `grades.scores.metadata.recommendationsLimited = true` so Plan 9 can show a banner.
8. Insert rows into `recommendations` (rank by index, 1-based).
9. Publish `report.recommendations.completed` with `{ count: rows.length }`.
10. **Generate report token + row.** 32 bytes crypto-random → hex-encode (64 chars). Insert `reports` row `{ gradeId, token }`. Token is the capability — stored raw, constant-time-compared in Plan 9's `/report/:id` route.
11. **Flip tier LAST.** `UPDATE grades SET tier = 'paid' WHERE id = gradeId`. This is the atomic "report is ready" signal.
12. Publish `{ type: 'report.done', gradeId }`.

**Failure modes:**

- Any thrown error between steps 1–11: BullMQ retries up to 3 times with exponential backoff. Between retries, `clearGradeArtifacts` is NOT called (we keep partial probe rows; the recomputed scores or recommendation LLM might have run on the previous attempt). The retry picks up from step 1 — rerunning the delta probes just adds more probe rows with later `createdAt` (the scoring engine deduplicates by provider+category+label, so redundant probes don't skew scores).
- After 3 failed retries: publish `{ type: 'report.failed', gradeId, error: string }`. `grades.tier` stays `'free'` (untouched — the LAST write in the happy path, so any retry that fails before step 11 leaves tier as `'free'`).

**Invariants (enforced by flow ordering):**
- `tier='paid'` ⟹ `reports` row exists AND at least 0 recommendation rows AND all 4 providers' probes exist.
- `stripe_payments.status='paid'` ⟹ money captured; does NOT imply report-ready.
- The single source of truth for "report is ready for viewing" is `tier='paid'` on the grade.

## 6. SSE events

All published to the existing `grade:<gradeId>` Redis pub/sub channel. The Plan 6a SSE endpoint (`GET /grades/:id/events`) already hydrates past events from the DB on reconnect. Plan 8 extends the hydration: when serializing past state, synthesize `report.probe.completed` events for any probes with `provider IN ('gemini', 'perplexity')` (detected by checking their provider column), and a `report.done` event if `tier='paid'`.

**New event types (all carry `{ gradeId }` plus shape-specific fields):**

| type | fields | when |
|---|---|---|
| `report.started` | — | worker enters processor |
| `report.probe.started` | `{ provider, category, label }` | before running a probe |
| `report.probe.completed` | `{ provider, category, label, score, durationMs }` | after a probe persists |
| `report.recommendations.started` | — | before the LLM call |
| `report.recommendations.completed` | `{ count }` | after recommendation rows persist |
| `report.done` | `{ reportId }` | after tier='paid' flip |
| `report.failed` | `{ error }` | after 3rd BullMQ retry fails |

**Frontend reducer:** the existing `reduceGradeEvents` (Plan 6b) extended with `report.*` cases. Adds a `paidStatus: 'none' | 'checking_out' | 'generating' | 'ready' | 'failed'` field to `GradeState`. State transitions:
- `free + done` → `paidStatus: 'none'`.
- On `checkout=complete` URL param → `paidStatus: 'checking_out'`.
- On first `report.started` or `report.probe.*` → `'generating'`.
- On `report.done` → `'ready'`.
- On `report.failed` → `'failed'`.

## 7. Frontend UI state machine

LiveGradePage composes two new components:
- `BuyReportButton` — visible when `phase='done'` AND `paidStatus='none'`. Click → `postBillingCheckout(gradeId)` → redirect to Stripe. On 409 `already_paid`, transition to `paidStatus: 'ready'`.
- `PaidReportStatus` — visible when `paidStatus !== 'none'`. Renders one of four sub-states:
  - `checking_out`: "Payment received! Your paid report is being generated…" + spinner.
  - `generating`: same banner + animates in the new Gemini/Perplexity probe rows into the existing probe log (the `ProbeLogRow` component already handles per-provider rendering — no changes there).
  - `ready`: "Your paid report is ready." + link `/report/:id?t=<token>` with a subtle "Full rendering lands in Plan 9" note. Token comes from `GET /grades/:id` (Plan 9 will also expose it via `report.done` event payload; in Plan 8 the frontend reads it via a refetch on the done event).
  - `failed`: "Something went wrong generating your report. We've been notified and will refund your payment within 24h." + mailto support link.

**URL param handling (useEffect on mount):**
- `?checkout=complete` → set `paidStatus = 'checking_out'`, strip param via `history.replaceState`.
- `?checkout=canceled` → show `CheckoutCanceledToast` for 5s, strip param.

**SSE reconnect behavior:** the existing `useGradeEvents` hook opens a fresh SSE connection on mount. After `checkout=complete`, nothing special needs to happen in the frontend — the stream will deliver `report.*` events as the worker runs (or the hydration will synthesize them if the user lands on the page after the job finished).

## 8. Data model

No schema changes. Plan 8 writes rows to tables Plan 1 created:
- `stripe_payments` — Plan 8 is the first writer.
- `recommendations` — Plan 8 is the first writer.
- `reports` — Plan 8 is the first writer.
- `probes` — more rows added (provider = 'gemini' | 'perplexity').
- `grades` — updates `tier`, `overall`, `letter`, `scores` on the flip.

**Helpful existing constraints:** `stripe_payments.sessionId` is UNIQUE (Plan 1), so an INSERT for a duplicate session_id fails cleanly. `reports.gradeId` is UNIQUE (Plan 1), so we can never accidentally write two report rows for the same grade.

## 9. Env vars

New in `src/config/env.ts`:

```
STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional()   // sk_test_ or sk_live_
STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional()
STRIPE_PRICE_ID: z.string().startsWith('price_').optional()
```

All three added to `superRefine`'s `required` list when `NODE_ENV === 'production'`.

**Dev fallback:** when any of the three is missing in dev/test, the `/billing/checkout` and `/billing/webhook` routes short-circuit to `503 { error: 'stripe_not_configured' }`. The rest of the app continues to work (free grades unaffected). A module-level `console.warn` fires once at server startup if Stripe is unconfigured.

**`.env.example`:** three commented lines with short explanations. Dev-mode instructions: use `stripe listen --forward-to localhost:7777/billing/webhook` + Stripe CLI test keys.

## 10. Testing

### 10.1 Unit tests with fakes

`tests/unit/_helpers/fake-stripe.ts` — implements `BillingClient`:
- `createCheckoutSession(input)` returns a fake `Session` with a predictable id shape (e.g. `cs_test_fake_<uuid>`) and `url: 'https://fake.stripe.test/cs_test_fake_<uuid>'`. Records calls for assertion.
- `verifyWebhookSignature(body, sig, secret)` — in the fake, `sig` of the literal string `'fake-sig-valid'` returns the parsed JSON; any other sig throws. The fake also exposes a helper `constructEvent({type, gradeId, sessionId, amountTotal, currency})` that produces the `{ body, sig }` pair the webhook route expects.

`tests/unit/server/routes/billing-checkout.test.ts` — 8 cases:
1. Happy: valid gradeId + owning cookie → 200 with session URL, stripe_payments row inserted.
2. Non-existent grade → 404.
3. Cookie mismatch → 404.
4. Grade not done → 409 grade_not_done.
5. Already paid (existing row with status='paid') → 409 already_paid with reportId.
6. Pending session, Stripe says 'open' → returns existing URL.
7. Pending session, Stripe says 'expired' → soft-fails old row, creates new one.
8. Zod validation: missing/malformed gradeId → 400.

`tests/unit/server/routes/billing-webhook.test.ts` — 6 cases:
1. Happy: valid signature + checkout.session.completed → updates row to 'paid', enqueues job.
2. Invalid signature → 400.
3. Unknown event type (`payment_intent.succeeded`) → 200 no-op.
4. Missing metadata.gradeId → 400.
5. Unknown session id → 400 (tamper signal).
6. Duplicate webhook (already 'paid') → 200 no-op, no job re-enqueued.

`tests/unit/queue/workers/generate-report.test.ts` — 10 cases covering the full processor flow with `FakeStore` + `MockProvider` for Gemini/Perplexity + `FakeRecommender`:
1. Happy: all steps complete, tier flips to 'paid', events published in order.
2. Delta probes: assert ONLY Gemini + Perplexity probes are added (Claude/GPT rows untouched).
3. Rescoring: composite changes when new probes have different scores than existing ones.
4. Recommendation LLM happy path: 6 valid recommendations → 6 rows inserted.
5. Recommendation LLM retry: first call returns invalid JSON, second call returns 5 valid → success.
6. Recommendation LLM double-failure: both calls fail → 0 rows persisted, `grades.scores.metadata.recommendationsLimited = true`.
7. Failure before tier flip: any step 1–10 throws → tier stays 'free', `report.failed` published.
8. Tier flip is LAST: a failure injected right before step 11 leaves tier='free'.
9. Events published in correct order: `report.started` → probe events → recommendations events → `report.done`.
10. Token is cryptographically random: two runs produce different tokens.

`tests/unit/scoring/composite-rescore.test.ts` — 3 cases:
1. Rescore with 4 providers produces composite different from rescore with 2.
2. Null category (e.g. accuracy with all-null) handled correctly.
3. Pure function — no side effects.

### 10.2 Integration tests (testcontainers Postgres + Redis)

`tests/integration/billing-webhook.test.ts` — constructs real Stripe events using the real `stripe` Node SDK's test-helpers (locally signed with a test webhook secret; no network calls). POSTs them to `/billing/webhook`; asserts DB state + that a BullMQ job lands in the `generate-report` queue.

`tests/integration/generate-report-lifecycle.test.ts` — end-to-end: seeds a free grade with Claude+GPT probes (direct DB inserts), enqueues a `generate-report` job, lets it run, polls DB until `grades.tier='paid'`, asserts:
- `probes` table has rows for all 4 providers.
- `recommendations` table has ≥ 5 rows.
- `reports` table has 1 row with a 64-char hex token.
- `grades.tier = 'paid'`, `grades.overall` and `grades.scores` were recomputed.

### 10.3 Frontend tests (RTL + happy-dom)

- `BuyReportButton` — renders only when phase='done' AND paidStatus='none'. Click → api.ts called with gradeId. On 409 already_paid, transitions paidStatus.
- `PaidReportStatus` — renders appropriate sub-state for each of the 4 paidStatus values.
- `LiveGradePage` — 4 new cases: checkout=complete banner shown, checkout=canceled toast shown, paidStatus=ready shows view-report link, paidStatus=failed shows error banner.
- `useGradeEvents` reducer — extended to handle `report.*` events; assertions on `paidStatus` transitions and probe-log additions for report-tier probes.

### 10.4 Test counts

- ~18 new unit tests (including frontend RTL)
- ~4 integration tests
- Project totals after Plan 8: ~400 unit / ~65 integration.

## 11. Production-checklist diff

### 11.1 Added by Plan 8

- **Auto-refund on generate-report failure.** Currently: grade marked with error flag, manual Stripe-dashboard refund. Before real traffic, add: on 3rd BullMQ retry failure, call `stripe.refunds.create({ payment_intent })`, update `stripe_payments.status='refunded'`, publish `report.refunded` event. Needs careful handling of partial work (recommendations already persisted but no `reports` row).
- **Admin dashboard for payment reconciliation.** Need a way to see paid-but-failed grades, trigger manual refunds, retry failed jobs. Not MVP-blocking, but Plan 8 ships without it — any issue requires DB + Stripe-dashboard back-and-forth.
- **Rate-limit on `/billing/checkout`.** Plan 8 doesn't add one. A malicious cookie-holder can hit the endpoint repeatedly, spamming `stripe_payments` with orphan pending rows. Bounded (session tied to one owned grade), but worth a modest per-cookie bucket before public launch.
- **Real Stripe webhook registration + CLI smoke test.** Plan 10 deploy work — register prod webhook URL in the Stripe dashboard, grab the signing secret, set env vars. Run a real-mode test via Stripe CLI (`stripe trigger checkout.session.completed`).

### 11.2 Unchanged

All other items from prior plans (Plan 7's 4 deferred + Plans 1–6b's items) stay as-is.

## 12. Master-spec anchor

Plan 8 extends master spec §7.3 (paid tier) + §4.3 (trace steps 5). After merge, master spec gets an anchor paragraph under §7.3 pointing at this sub-spec.

---

**Open points at spec-write time (none expected to change the design):**
- Recommendation LLM prompt text — derived from master spec §8.4 but the exact wording is polish in Task implementation.
- Exact copy for "report is ready" UI banner — trivial.
- Whether `report.done` event carries the token or the frontend refetches `GET /grades/:id` to pick it up — decided at implementation. Leaning "event carries it" since the worker has it anyway.
