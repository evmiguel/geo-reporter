# GEO Reporter Plan 8 — Stripe Paywall + generate-report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `Get the full report — $19` button on LiveGradePage to a real Stripe Checkout flow, run a delta-probe + recommendation-LLM pipeline on payment, and persist a `reports` row with a random-token capability. Plan 9 will render `/report/:id`.

**Architecture:** Two new routes (`POST /billing/checkout`, `POST /billing/webhook`) behind a small `BillingClient` seam. One new BullMQ worker (`generate-report`) that delta-probes Gemini + Perplexity, recomputes composite scores from existing probes, runs the recommendation LLM, writes `reports` + flips `grades.tier='paid'`. Frontend extends `useGradeEvents` with `report.*` event types and surfaces four new UI states (checkout in progress, generating, ready, failed) on LiveGradePage.

**Tech Stack:** TypeScript 5.6+ strict, Hono 4, `stripe` 17 Node SDK (new runtime dep), BullMQ 5, Drizzle 0.33, vitest 2 + testcontainers 10, React 18 + RTL.

---

## Spec references

- Sub-spec (source of truth): `docs/superpowers/specs/2026-04-19-geo-reporter-plan-8-stripe-paywall-design.md`
- Master spec: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` §7.3 (paid tier) + §4.3 step 5 (generate-report trace) + §8.4 (recommendation LLM).

**Interpretation calls locked in (sub-spec §2, brainstormed 2026-04-19):**
- P8-1: Plan 8 ends at `tier='paid'` + `reports` row; Plan 9 renders `/report/:id`.
- P8-2: Delta probe — run only Gemini + Perplexity, recompute composite from existing rows.
- P8-3: Two `/billing/checkout` guards — 409 on already-paid, resume existing pending session, else new.
- P8-4: Manual Stripe refund on `generate-report` failure; auto-refund deferred to production checklist.
- P8-5: Reuse `grade:<id>` Redis channel with new `report.*` event types.
- P8-6: Mock Stripe SDK for unit tests; construct signed events locally for webhook tests.
- P8-7: Full event granularity — per-probe + recommendation LLM events.

---

## File structure

```
src/billing/
├── types.ts                              NEW — BillingClient interface + CheckoutSession shape + Webhook event type
├── stripe-client.ts                      NEW — StripeBillingClient wrapping the stripe SDK
└── prices.ts                             NEW — PRICE_AMOUNT_CENTS constant + helper

src/config/env.ts                         MODIFY — add STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID

src/server/
├── app.ts                                MODIFY — mount /billing sub-app; webhook route skips cookie middleware
├── deps.ts                               MODIFY — add billing: BillingClient, reportQueue: Queue<ReportJob>
├── server.ts                             MODIFY — instantiate BillingClient (or null when unconfigured); expose reportQueue
└── routes/
    └── billing.ts                        NEW — POST /checkout (cookie auth) + POST /webhook (signature auth)

src/store/
├── types.ts                              MODIFY — add stripe-payment methods
└── postgres.ts                           MODIFY — implement stripe-payment methods

src/queue/events.ts                       MODIFY — extend GradeEvent union with report.*; close iterator on report.done/report.failed

src/server/routes/grades-events.ts        MODIFY — hydrate paid-tier probes as synthesized report.probe.completed events + synthesize report.done if tier=paid

src/scoring/rescore.ts                    NEW — rescoreFromProbes(rows): { overall, letter, scores } pure function

src/llm/prompts.ts                        MODIFY — add promptRecommender(inputs)

src/queue/workers/generate-report/
├── index.ts                              NEW — registerGenerateReportWorker(deps, connection): Worker
├── deps.ts                               NEW — GenerateReportDeps interface
├── recommender.ts                        NEW — runRecommender(deps, inputs): Recommendation[] with retry-once semantics
├── probes.ts                             NEW — runDeltaProbes(deps, grade, scrape): void — runs Gemini + Perplexity through all probe flows
└── generate-report.ts                    NEW — Processor function: publish events + delta probes + rescore + recommender + reports row + tier flip

src/worker/worker.ts                      MODIFY — register generate-report worker alongside run-grade and health

src/web/
├── lib/
│   ├── types.ts                          MODIFY — extend GradeEvent union with report.*; add paidStatus to GradeState
│   ├── grade-reducer.ts                  MODIFY — handle report.* events; derive paidStatus
│   └── api.ts                            MODIFY — add postBillingCheckout(gradeId)
├── components/
│   ├── BuyReportButton.tsx               NEW — "Get the full report — $19" CTA
│   ├── PaidReportStatus.tsx              NEW — 4-state banner (checking_out / generating / ready / failed)
│   └── CheckoutCanceledToast.tsx         NEW — 5s toast when ?checkout=canceled
└── pages/
    └── LiveGradePage.tsx                 MODIFY — compose the new components; read ?checkout=... params; strip on mount

tests/unit/
├── _helpers/
│   ├── fake-stripe.ts                    NEW — in-memory BillingClient + event-constructor helper
│   └── fake-recommender.ts               NEW — deterministic Recommendation[] stub
├── billing/
│   └── stripe-client.test.ts             NEW — session-create arg shape + signature construction
├── scoring/
│   └── rescore.test.ts                   NEW — pure rescoreFromProbes
├── server/routes/
│   ├── billing-checkout.test.ts          NEW — ~8 cases
│   └── billing-webhook.test.ts           NEW — ~6 cases
├── queue/events.test.ts                  MODIFY — add cases for report.* iterator behavior
├── queue/workers/
│   ├── generate-report.test.ts           NEW — ~10 cases
│   └── recommender.test.ts               NEW — retry-once + validation
└── web/
    ├── grade-reducer.test.ts             MODIFY — report.* cases + paidStatus transitions
    ├── components/BuyReportButton.test.tsx NEW
    ├── components/PaidReportStatus.test.tsx NEW
    └── pages/LiveGradePage.test.tsx      MODIFY — 4 new state cases

tests/integration/
├── billing-webhook.test.ts               NEW — real-SDK event construction; asserts DB + job enqueue
├── generate-report-lifecycle.test.ts     NEW — seeds free grade → enqueues job → asserts final state
└── grades-events-report-hydration.test.ts NEW — SSE /events emits synthesized report.* on reconnect

docs/production-checklist.md              MODIFY — add 4 new items
docs/superpowers/specs/2026-04-17-geo-reporter-design.md MODIFY — anchor under §7.3
README.md                                 MODIFY — roadmap + browser-flow mention
```

---

## Project constraints (from CLAUDE.md)

- `.ts` extensions on ALL imports (Node ESM).
- `import type` for type-only imports (`verbatimModuleSyntax: true`).
- `exactOptionalPropertyTypes: true` — conditionally spread optional fields, never assign `undefined`.
- `noUncheckedIndexedAccess: true` — check destructures + array access with explicit guards.
- Store access goes through `GradeStore`; `PostgresStore` is the only impl; no `import { db }` in feature code.
- Git commits: inline identity only:
  ```
  git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit ...
  ```
- Integration tests use testcontainers (Postgres + Redis); no mocks in integration tier.

---

## Task 1: Stripe runtime dep + env vars

**Files:**
- Modify: `package.json` (add `stripe` runtime dep)
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Test: `tests/unit/config/env.test.ts`

- [ ] **Step 1: Install the Stripe SDK**

```bash
cd /home/erika/repos/geo-grader-v3/.worktrees/plan-8-stripe
pnpm add stripe@^17
```

(The worktree setup step happens in the subagent dispatch outer shell — not in this task.)

- [ ] **Step 2: Write the failing env-var tests**

Append to `tests/unit/config/env.test.ts`:

```ts
describe('env — Plan 8 Stripe vars', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o',
    GEMINI_API_KEY: 'sk-g', PERPLEXITY_API_KEY: 'sk-p',
    COOKIE_HMAC_KEY: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'http://localhost:5173',
  }

  it('accepts missing Stripe keys in development', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development' })
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.STRIPE_WEBHOOK_SECRET).toBeUndefined()
    expect(env.STRIPE_PRICE_ID).toBeUndefined()
  })

  it('accepts test-mode Stripe keys', () => {
    const env = loadEnv({
      ...base, NODE_ENV: 'development',
      STRIPE_SECRET_KEY: 'sk_test_abc123',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
      STRIPE_PRICE_ID: 'price_abc123',
    })
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_abc123')
    expect(env.STRIPE_PRICE_ID).toBe('price_abc123')
  })

  it('rejects STRIPE_SECRET_KEY without sk_ prefix', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', STRIPE_SECRET_KEY: 'abc' }))
      .toThrow(/STRIPE_SECRET_KEY/)
  })

  it('rejects STRIPE_WEBHOOK_SECRET without whsec_ prefix', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', STRIPE_WEBHOOK_SECRET: 'abc' }))
      .toThrow(/STRIPE_WEBHOOK_SECRET/)
  })

  it('rejects STRIPE_PRICE_ID without price_ prefix', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', STRIPE_PRICE_ID: 'abc' }))
      .toThrow(/STRIPE_PRICE_ID/)
  })

  it('requires all 3 Stripe vars in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/STRIPE_SECRET_KEY/)
    expect(() => loadEnv({
      ...base, NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_abc',
    })).toThrow(/STRIPE_WEBHOOK_SECRET/)
    expect(() => loadEnv({
      ...base, NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
    })).toThrow(/STRIPE_PRICE_ID/)
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

`pnpm test -- tests/unit/config/env.test.ts`

- [ ] **Step 4: Extend the schema**

In `src/config/env.ts`, inside the `z.object({...})` block add (after `PUBLIC_BASE_URL`):

```ts
STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
STRIPE_PRICE_ID: z.string().startsWith('price_').optional(),
```

Inside the `superRefine` block, extend `required` to include the three new keys:

```ts
const required = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY',
  'COOKIE_HMAC_KEY', 'PUBLIC_BASE_URL',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID',
] as const
```

- [ ] **Step 5: Run tests — expect PASS**

`pnpm test -- tests/unit/config/env.test.ts`
Expected: prior tests + 6 new pass.

- [ ] **Step 6: Append to `.env.example`**

```
# Plan 8 — Stripe
# STRIPE_SECRET_KEY: test-mode (sk_test_...) or live-mode (sk_live_...) API key.
# Required in production. Get from https://dashboard.stripe.com/apikeys.
# STRIPE_SECRET_KEY=

# STRIPE_WEBHOOK_SECRET: signing secret for the /billing/webhook endpoint.
# For local dev, get one from: stripe listen --forward-to localhost:7777/billing/webhook
# STRIPE_WEBHOOK_SECRET=

# STRIPE_PRICE_ID: the Stripe-side price that represents the $19 GEO Report.
# Create once in the Stripe dashboard (or via CLI).
# STRIPE_PRICE_ID=
```

- [ ] **Step 7: Full validation**

`pnpm test` (all existing + 6 new pass), `pnpm typecheck` (clean).

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/config/env.ts tests/unit/config/env.test.ts .env.example
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): add stripe SDK and Stripe env vars"
```

---

## Task 2: BillingClient interface + StripeBillingClient + price constant

**Files:**
- Create: `src/billing/types.ts`
- Create: `src/billing/prices.ts`
- Create: `src/billing/stripe-client.ts`

- [ ] **Step 1: Write `src/billing/types.ts`**

```ts
export interface CheckoutSessionInput {
  gradeId: string
  successUrl: string
  cancelUrl: string
  priceId: string
}

export interface CheckoutSession {
  id: string
  url: string
  status: 'open' | 'complete' | 'expired'
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required'
  amountTotal: number | null
  currency: string | null
  metadata: { gradeId?: string }
}

export interface WebhookEvent {
  id: string
  type: string
  data: {
    object: {
      id: string
      metadata?: { gradeId?: string }
      amount_total?: number
      currency?: string
      payment_intent?: string
    }
  }
}

export interface BillingClient {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession>
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): WebhookEvent
}
```

- [ ] **Step 2: Write `src/billing/prices.ts`**

```ts
export const PRICE_AMOUNT_CENTS = 1900
export const PRICE_CURRENCY = 'usd'
```

- [ ] **Step 3: Write `src/billing/stripe-client.ts`**

```ts
import Stripe from 'stripe'
import type { BillingClient, CheckoutSession, CheckoutSessionInput, WebhookEvent } from './types.ts'

export interface StripeBillingClientOptions {
  secretKey: string
}

export class StripeBillingClient implements BillingClient {
  private readonly stripe: Stripe

  constructor(options: StripeBillingClientOptions) {
    this.stripe = new Stripe(options.secretKey, { apiVersion: '2024-11-20.acacia' })
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: input.priceId, quantity: 1 }],
      metadata: { gradeId: input.gradeId },
      client_reference_id: input.gradeId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    })
    return this.toSession(session)
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId)
    return this.toSession(session)
  }

  verifyWebhookSignature(rawBody: string, signature: string, secret: string): WebhookEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, secret)
    return {
      id: event.id,
      type: event.type,
      data: {
        object: event.data.object as WebhookEvent['data']['object'],
      },
    }
  }

  private toSession(session: Stripe.Checkout.Session): CheckoutSession {
    return {
      id: session.id,
      url: session.url ?? '',
      status: (session.status ?? 'open') as CheckoutSession['status'],
      paymentStatus: session.payment_status as CheckoutSession['paymentStatus'],
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: { ...(session.metadata?.gradeId != null ? { gradeId: session.metadata.gradeId } : {}) },
    }
  }
}
```

- [ ] **Step 4: Typecheck**

`pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/billing/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): add BillingClient interface and StripeBillingClient"
```

---

## Task 3: FakeStripe + FakeRecommender test helpers

**Files:**
- Create: `tests/unit/_helpers/fake-stripe.ts`
- Create: `tests/unit/_helpers/fake-recommender.ts`

- [ ] **Step 1: Write `tests/unit/_helpers/fake-stripe.ts`**

```ts
import { createHmac } from 'node:crypto'
import type { BillingClient, CheckoutSession, CheckoutSessionInput, WebhookEvent } from '../../../src/billing/types.ts'

interface StoredSession extends CheckoutSession {
  _payment_intent?: string
}

export interface ConstructedWebhookEvent {
  body: string
  signature: string
}

export class FakeStripe implements BillingClient {
  readonly createdSessions: CheckoutSessionInput[] = []
  readonly sessions = new Map<string, StoredSession>()
  private counter = 0

  constructor(readonly webhookSecret: string = 'whsec_test_fake') {}

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    this.createdSessions.push(input)
    const id = `cs_test_fake_${++this.counter}_${input.gradeId}`
    const session: StoredSession = {
      id,
      url: `https://fake.stripe.test/${id}`,
      status: 'open',
      paymentStatus: 'unpaid',
      amountTotal: null,
      currency: null,
      metadata: { gradeId: input.gradeId },
      _payment_intent: `pi_test_fake_${this.counter}`,
    }
    this.sessions.set(id, session)
    return session
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`FakeStripe: unknown session ${sessionId}`)
    return session
  }

  // Tests call this to simulate "the user paid" before constructing the webhook event.
  completeSession(sessionId: string, amountTotal: number = 1900, currency: string = 'usd'): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`FakeStripe: unknown session ${sessionId}`)
    session.status = 'complete'
    session.paymentStatus = 'paid'
    session.amountTotal = amountTotal
    session.currency = currency
  }

  expireSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`FakeStripe: unknown session ${sessionId}`)
    session.status = 'expired'
  }

  // Constructs a signed webhook event using the same HMAC scheme Stripe uses
  // (t=<ts>,v1=<sig>). The verifyWebhookSignature below checks it.
  constructEvent(input: {
    type: string
    sessionId: string
    gradeId: string
    amountTotal?: number
    currency?: string
    paymentIntent?: string
  }): ConstructedWebhookEvent {
    const event: WebhookEvent = {
      id: `evt_test_${this.counter++}`,
      type: input.type,
      data: {
        object: {
          id: input.sessionId,
          metadata: { gradeId: input.gradeId },
          ...(input.amountTotal !== undefined ? { amount_total: input.amountTotal } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.paymentIntent !== undefined ? { payment_intent: input.paymentIntent } : {}),
        },
      },
    }
    const body = JSON.stringify(event)
    const ts = Math.floor(Date.now() / 1000)
    const signedPayload = `${ts}.${body}`
    const sig = createHmac('sha256', this.webhookSecret).update(signedPayload).digest('hex')
    const signature = `t=${ts},v1=${sig}`
    return { body, signature }
  }

  verifyWebhookSignature(rawBody: string, signature: string, secret: string): WebhookEvent {
    if (secret !== this.webhookSecret) throw new Error('FakeStripe: webhook secret mismatch')
    const parts = new Map(signature.split(',').map((p) => {
      const eq = p.indexOf('=')
      return [p.slice(0, eq), p.slice(eq + 1)] as const
    }))
    const ts = parts.get('t')
    const v1 = parts.get('v1')
    if (!ts || !v1) throw new Error('FakeStripe: malformed signature')
    const signedPayload = `${ts}.${rawBody}`
    const expected = createHmac('sha256', secret).update(signedPayload).digest('hex')
    if (expected !== v1) throw new Error('FakeStripe: signature mismatch')
    return JSON.parse(rawBody) as WebhookEvent
  }
}
```

- [ ] **Step 2: Write `tests/unit/_helpers/fake-recommender.ts`**

```ts
import type { NewRecommendation } from '../../../src/store/types.ts'

export interface FakeRecommenderInput {
  url: string
  scrapeText: string
}

export interface RecommenderResult {
  recommendations: NewRecommendation[]
  attempts: number
  limited: boolean
}

export class FakeRecommender {
  readonly calls: FakeRecommenderInput[] = []

  constructor(
    private readonly result: () => RecommenderResult = () => ({
      recommendations: defaultRecs('fake-grade'),
      attempts: 1,
      limited: false,
    }),
  ) {}

  async generate(input: FakeRecommenderInput & { gradeId: string }): Promise<RecommenderResult> {
    this.calls.push({ url: input.url, scrapeText: input.scrapeText })
    return this.result()
  }
}

function defaultRecs(gradeId: string): NewRecommendation[] {
  return [1, 2, 3, 4, 5].map((rank) => ({
    gradeId,
    rank,
    title: `Rec ${rank}`,
    category: 'recognition',
    impact: 4,
    effort: 2,
    rationale: 'because',
    how: 'do the thing',
  }))
}
```

- [ ] **Step 3: Typecheck**

`pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/_helpers/fake-stripe.ts tests/unit/_helpers/fake-recommender.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(billing): add FakeStripe and FakeRecommender helpers"
```

---

## Task 4: Store — stripe_payments methods

**Files:**
- Modify: `src/store/types.ts` — add 4 methods to `GradeStore`
- Modify: `src/store/postgres.ts` — implement all 4
- Modify: `tests/unit/_helpers/fake-store.ts` — in-memory impls
- Test: `tests/unit/store/fake-store-stripe-payments.test.ts` (new)
- Test: `tests/integration/store-stripe-payments.test.ts` (new)

- [ ] **Step 1: Extend the interface**

In `src/store/types.ts`, add after the magic-link methods:

```ts
// Billing — stripe_payments (Plan 8)
createStripePayment(input: {
  gradeId: string
  sessionId: string
  amountCents: number
  currency: string
}): Promise<StripePayment>
getStripePaymentBySessionId(sessionId: string): Promise<StripePayment | null>
updateStripePaymentStatus(
  sessionId: string,
  patch: { status: 'paid' | 'refunded' | 'failed'; amountCents?: number; currency?: string },
): Promise<void>
listStripePaymentsByGrade(gradeId: string): Promise<StripePayment[]>
```

- [ ] **Step 2: Write fake-store tests**

Create `tests/unit/store/fake-store-stripe-payments.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore stripe_payments', () => {
  it('create + getBySessionId round-trip', async () => {
    const store = makeFakeStore()
    const g = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free' })
    await store.createStripePayment({
      gradeId: g.id, sessionId: 'cs_test_1', amountCents: 1900, currency: 'usd',
    })
    const row = await store.getStripePaymentBySessionId('cs_test_1')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('pending')
    expect(row!.gradeId).toBe(g.id)
  })

  it('updateStatus flips pending → paid', async () => {
    const store = makeFakeStore()
    const g = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free' })
    await store.createStripePayment({
      gradeId: g.id, sessionId: 'cs_test_2', amountCents: 1900, currency: 'usd',
    })
    await store.updateStripePaymentStatus('cs_test_2', { status: 'paid', amountCents: 1900, currency: 'usd' })
    const row = await store.getStripePaymentBySessionId('cs_test_2')
    expect(row!.status).toBe('paid')
  })

  it('listStripePaymentsByGrade returns all rows for a grade', async () => {
    const store = makeFakeStore()
    const g = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free' })
    await store.createStripePayment({ gradeId: g.id, sessionId: 'cs_a', amountCents: 1900, currency: 'usd' })
    await store.createStripePayment({ gradeId: g.id, sessionId: 'cs_b', amountCents: 1900, currency: 'usd' })
    const rows = await store.listStripePaymentsByGrade(g.id)
    expect(rows).toHaveLength(2)
  })

  it('getBySessionId returns null for unknown id', async () => {
    const store = makeFakeStore()
    expect(await store.getStripePaymentBySessionId('nonexistent')).toBeNull()
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

`pnpm test -- tests/unit/store/fake-store-stripe-payments.test.ts`

- [ ] **Step 4: Implement in FakeStore**

In `tests/unit/_helpers/fake-store.ts`, add `stripePaymentsMap: Map<string, StripePayment>` to `FakeGradeStore` interface and to the `makeFakeStore` return. Implement the four methods:

```ts
// Add to FakeGradeStore interface:
stripePaymentsMap: Map<string, StripePayment>

// Inside makeFakeStore, before return:
const stripePaymentsMap = new Map<string, StripePayment>()

// Inside return object:
stripePaymentsMap,

async createStripePayment(input): Promise<StripePayment> {
  const row: StripePayment = {
    id: crypto.randomUUID(),
    gradeId: input.gradeId,
    sessionId: input.sessionId,
    status: 'pending',
    amountCents: input.amountCents,
    currency: input.currency,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  stripePaymentsMap.set(input.sessionId, row)
  return row
},

async getStripePaymentBySessionId(sessionId): Promise<StripePayment | null> {
  return stripePaymentsMap.get(sessionId) ?? null
},

async updateStripePaymentStatus(sessionId, patch): Promise<void> {
  const existing = stripePaymentsMap.get(sessionId)
  if (!existing) return
  stripePaymentsMap.set(sessionId, {
    ...existing,
    status: patch.status,
    amountCents: patch.amountCents ?? existing.amountCents,
    currency: patch.currency ?? existing.currency,
    updatedAt: new Date(),
  })
},

async listStripePaymentsByGrade(gradeId): Promise<StripePayment[]> {
  return [...stripePaymentsMap.values()].filter((r) => r.gradeId === gradeId)
},
```

Add to top-of-file `import type { StripePayment }` alongside existing imports.

- [ ] **Step 5: Run fake-store tests — expect PASS**

`pnpm test -- tests/unit/store/fake-store-stripe-payments.test.ts`

- [ ] **Step 6: Write integration test**

Create `tests/integration/store-stripe-payments.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => { testDb = await startTestDb(); store = new PostgresStore(testDb.db) }, 60_000)
afterAll(async () => { await testDb.stop() })
beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, cookies, users CASCADE`)
})

describe('PostgresStore stripe_payments', () => {
  it('create + getBySessionId', async () => {
    const grade = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_test_int_1', amountCents: 1900, currency: 'usd',
    })
    const row = await store.getStripePaymentBySessionId('cs_test_int_1')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('pending')
  })

  it('duplicate sessionId INSERT raises (UNIQUE constraint)', async () => {
    const grade = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_dup', amountCents: 1900, currency: 'usd',
    })
    await expect(store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_dup', amountCents: 1900, currency: 'usd',
    })).rejects.toThrow()
  })

  it('updateStatus to paid', async () => {
    const grade = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_u1', amountCents: 1900, currency: 'usd',
    })
    await store.updateStripePaymentStatus('cs_u1', { status: 'paid', amountCents: 1900, currency: 'usd' })
    const row = await store.getStripePaymentBySessionId('cs_u1')
    expect(row!.status).toBe('paid')
  })

  it('listStripePaymentsByGrade', async () => {
    const grade = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.createStripePayment({ gradeId: grade.id, sessionId: 'cs_l1', amountCents: 1900, currency: 'usd' })
    await store.createStripePayment({ gradeId: grade.id, sessionId: 'cs_l2', amountCents: 1900, currency: 'usd' })
    const rows = await store.listStripePaymentsByGrade(grade.id)
    expect(rows).toHaveLength(2)
  })
})
```

- [ ] **Step 7: Implement in PostgresStore**

Add to `src/store/postgres.ts` (after the magic-link methods):

```ts
async createStripePayment(input: {
  gradeId: string
  sessionId: string
  amountCents: number
  currency: string
}): Promise<StripePayment> {
  const [row] = await this.db.insert(schema.stripePayments).values({
    gradeId: input.gradeId,
    sessionId: input.sessionId,
    amountCents: input.amountCents,
    currency: input.currency,
    status: 'pending',
  }).returning()
  if (!row) throw new Error('createStripePayment returned no row')
  return row
}

async getStripePaymentBySessionId(sessionId: string): Promise<StripePayment | null> {
  const [row] = await this.db
    .select()
    .from(schema.stripePayments)
    .where(eq(schema.stripePayments.sessionId, sessionId))
    .limit(1)
  return row ?? null
}

async updateStripePaymentStatus(
  sessionId: string,
  patch: { status: 'paid' | 'refunded' | 'failed'; amountCents?: number; currency?: string },
): Promise<void> {
  await this.db.update(schema.stripePayments)
    .set({
      status: patch.status,
      updatedAt: new Date(),
      ...(patch.amountCents !== undefined ? { amountCents: patch.amountCents } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
    })
    .where(eq(schema.stripePayments.sessionId, sessionId))
}

async listStripePaymentsByGrade(gradeId: string): Promise<StripePayment[]> {
  return this.db.select().from(schema.stripePayments).where(eq(schema.stripePayments.gradeId, gradeId))
}
```

Add `StripePayment` to the imports at the top of postgres.ts (from `./types.ts`).

- [ ] **Step 8: Run integration — expect PASS**

`pnpm test:integration -- tests/integration/store-stripe-payments.test.ts`

- [ ] **Step 9: Full validation**

`pnpm test`, `pnpm test:integration`, `pnpm typecheck` all pass.

- [ ] **Step 10: Commit**

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts \
        tests/unit/store/fake-store-stripe-payments.test.ts tests/integration/store-stripe-payments.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): add stripe_payments methods"
```

---

## Task 5: POST /billing/checkout route

**Files:**
- Create: `src/server/routes/billing.ts` (first route — `/webhook` added in Task 6)
- Test: `tests/unit/server/routes/billing-checkout.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/server/routes/billing-checkout.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

type AppType = Hono<{ Variables: { cookie: string; clientIp: string } }>

function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe()
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/billing', billingRouter({
    store, billing,
    priceId: 'price_test_abc',
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue: null as unknown as import('bullmq').Queue, // checkout doesn't touch this
  }))
  return { app, store, billing }
}

async function issueCookie(app: AppType): Promise<string> {
  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gradeId: 'not-uuid' }),  // 400 triggers the cookie issuance
  }))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('POST /billing/checkout', () => {
  it('happy path: creates session + inserts stripe_payments row', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toMatch(/^https:\/\/fake\.stripe\.test\//)
    expect(billing.createdSessions).toHaveLength(1)
    expect(billing.createdSessions[0]!.gradeId).toBe(grade.id)
    const payments = await store.listStripePaymentsByGrade(grade.id)
    expect(payments).toHaveLength(1)
    expect(payments[0]!.status).toBe('pending')
  })

  it('404 on non-existent grade', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: '00000000-0000-0000-0000-000000000000' }),
    }))
    expect(res.status).toBe(404)
  })

  it('404 on non-owned grade', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: 'other-cookie', status: 'done' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(404)
  })

  it('409 grade_not_done', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'running' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('grade_not_done')
  })

  it('409 already_paid when stripe_payments has a paid row', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    await store.createStripePayment({ gradeId: grade.id, sessionId: 'cs_prior', amountCents: 1900, currency: 'usd' })
    await store.updateStripePaymentStatus('cs_prior', { status: 'paid' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; reportId: string }
    expect(body.error).toBe('already_paid')
    expect(body.reportId).toBe(grade.id)
  })

  it('resumes pending session when Stripe says it is still open', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    // Simulate a prior checkout call: create session in billing + insert row.
    const prior = await billing.createCheckoutSession({
      gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'price_test_abc',
    })
    await store.createStripePayment({ gradeId: grade.id, sessionId: prior.id, amountCents: 1900, currency: 'usd' })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toBe(prior.url)
    expect(billing.createdSessions).toHaveLength(1)  // no second session created
  })

  it('creates new session when prior pending session has expired at Stripe', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done' })
    const prior = await billing.createCheckoutSession({
      gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'price_test_abc',
    })
    await store.createStripePayment({ gradeId: grade.id, sessionId: prior.id, amountCents: 1900, currency: 'usd' })
    billing.expireSession(prior.id)
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(200)
    expect(billing.createdSessions).toHaveLength(2)  // new one created
    const priorRow = await store.getStripePaymentBySessionId(prior.id)
    expect(priorRow!.status).toBe('failed')  // old row soft-marked
  })

  it('400 on missing / malformed body', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: 'not-a-uuid' }),
    }))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

`pnpm test -- tests/unit/server/routes/billing-checkout.test.ts`

- [ ] **Step 3: Implement the route**

Create `src/server/routes/billing.ts`:

```ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Queue } from 'bullmq'
import type { BillingClient } from '../../billing/types.ts'
import { PRICE_AMOUNT_CENTS, PRICE_CURRENCY } from '../../billing/prices.ts'
import type { GradeStore } from '../../store/types.ts'
import type { ReportJob } from '../../queue/queues.ts'

export interface BillingRouterDeps {
  store: GradeStore
  billing: BillingClient
  priceId: string
  publicBaseUrl: string
  webhookSecret: string
  reportQueue: Queue<ReportJob>
}

type Env = { Variables: { cookie: string; clientIp: string } }

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const checkoutSchema = z.object({ gradeId: z.string().regex(UUID_REGEX) })

export function billingRouter(deps: BillingRouterDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post(
    '/checkout',
    zValidator('json', checkoutSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_body' }, 400)
    }),
    async (c) => {
      const { gradeId } = c.req.valid('json')
      const grade = await deps.store.getGrade(gradeId)
      if (!grade) return c.json({ error: 'not_found' }, 404)
      if (grade.cookie !== c.var.cookie) return c.json({ error: 'not_found' }, 404)
      if (grade.status !== 'done') return c.json({ error: 'grade_not_done' }, 409)

      const payments = await deps.store.listStripePaymentsByGrade(gradeId)
      const paid = payments.find((p) => p.status === 'paid')
      if (paid) return c.json({ error: 'already_paid', reportId: grade.id }, 409)

      const pending = payments.find((p) => p.status === 'pending')
      if (pending) {
        const remote = await deps.billing.retrieveCheckoutSession(pending.sessionId)
        if (remote.status === 'open') {
          return c.json({ url: remote.url })
        }
        // Stale: expired or completed-but-unpaid. Soft-fail the old row and fall through.
        await deps.store.updateStripePaymentStatus(pending.sessionId, { status: 'failed' })
      }

      const session = await deps.billing.createCheckoutSession({
        gradeId,
        priceId: deps.priceId,
        successUrl: `${deps.publicBaseUrl}/g/${gradeId}?checkout=complete`,
        cancelUrl: `${deps.publicBaseUrl}/g/${gradeId}?checkout=canceled`,
      })
      await deps.store.createStripePayment({
        gradeId, sessionId: session.id,
        amountCents: PRICE_AMOUNT_CENTS, currency: PRICE_CURRENCY,
      })
      return c.json({ url: session.url })
    },
  )

  // /webhook added in Task 6.
  return app
}
```

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/server/routes/billing-checkout.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Typecheck + commit**

`pnpm typecheck` clean.

```bash
git add src/server/routes/billing.ts tests/unit/server/routes/billing-checkout.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): POST /billing/checkout with pending-session resume + already-paid guard"
```

---

## Task 6: POST /billing/webhook route

**Files:**
- Modify: `src/server/routes/billing.ts` (append the webhook handler)
- Test: `tests/unit/server/routes/billing-webhook.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/server/routes/billing-webhook.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { Queue } from 'bullmq'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'

function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe()
  const fakeAdd = vi.fn().mockResolvedValue(undefined)
  const reportQueue = { add: fakeAdd } as unknown as Queue
  const app = new Hono()
  app.route('/billing', billingRouter({
    store, billing,
    priceId: 'price_test_abc',
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue,
  }))
  return { app, store, billing, fakeAdd }
}

describe('POST /billing/webhook', () => {
  it('happy path: flips pending → paid + enqueues generate-report job', async () => {
    const { app, store, billing, fakeAdd } = build()
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', status: 'done' })
    const session = await billing.createCheckoutSession({
      gradeId: grade.id, priceId: 'price_test_abc', successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd',
    })
    billing.completeSession(session.id)

    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      gradeId: grade.id,
      amountTotal: 1900,
      currency: 'usd',
    })

    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)
    const row = await store.getStripePaymentBySessionId(session.id)
    expect(row!.status).toBe('paid')
    expect(fakeAdd).toHaveBeenCalledWith(
      'generate-report',
      { gradeId: grade.id, sessionId: session.id },
      expect.objectContaining({ jobId: `generate-report:${session.id}` }),
    )
  })

  it('400 on invalid signature', async () => {
    const { app } = build()
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(res.status).toBe(400)
  })

  it('200 no-op on unknown event type', async () => {
    const { app, billing, fakeAdd } = build()
    const { body, signature } = billing.constructEvent({
      type: 'payment_intent.succeeded',
      sessionId: 'cs_irrelevant',
      gradeId: '00000000-0000-0000-0000-000000000000',
    })
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)
    expect(fakeAdd).not.toHaveBeenCalled()
  })

  it('400 when metadata.gradeId missing', async () => {
    const { app, billing } = build()
    // constructEvent always sets metadata; forge a body without it.
    const baseEvent = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: 'cs_fake',
      gradeId: '00000000-0000-0000-0000-000000000000',
    })
    const parsed = JSON.parse(baseEvent.body)
    delete parsed.data.object.metadata
    const body = JSON.stringify(parsed)
    // Re-sign with the modified body.
    const { createHmac } = await import('node:crypto')
    const ts = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', 'whsec_test_fake').update(`${ts}.${body}`).digest('hex')
    const signature = `t=${ts},v1=${sig}`
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(400)
  })

  it('400 when stripe_payments row missing for session', async () => {
    const { app, billing } = build()
    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: 'cs_never_inserted',
      gradeId: '00000000-0000-0000-0000-000000000000',
    })
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(400)
  })

  it('idempotent: duplicate webhook for already-paid session returns 200, no re-enqueue', async () => {
    const { app, store, billing, fakeAdd } = build()
    const grade = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free', status: 'done' })
    const session = await billing.createCheckoutSession({
      gradeId: grade.id, priceId: 'price_test_abc', successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd',
    })
    // Pre-mark as paid.
    await store.updateStripePaymentStatus(session.id, { status: 'paid' })

    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      gradeId: grade.id,
      amountTotal: 1900,
      currency: 'usd',
    })
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)
    expect(fakeAdd).not.toHaveBeenCalled()  // no re-enqueue
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

`pnpm test -- tests/unit/server/routes/billing-webhook.test.ts`

- [ ] **Step 3: Add the webhook handler**

Append to `src/server/routes/billing.ts` (inside `billingRouter`, BEFORE `return app`):

```ts
app.post('/webhook', async (c) => {
  const rawBuffer = await c.req.raw.arrayBuffer()
  const rawBody = new TextDecoder().decode(rawBuffer)
  const signature = c.req.header('stripe-signature')
  if (!signature) return c.json({ error: 'missing_signature' }, 400)

  let event
  try {
    event = deps.billing.verifyWebhookSignature(rawBody, signature, deps.webhookSecret)
  } catch {
    return c.json({ error: 'invalid_signature' }, 400)
  }

  if (event.type !== 'checkout.session.completed') {
    return c.body(null, 200)
  }

  const gradeId = event.data.object.metadata?.gradeId
  if (!gradeId || !UUID_REGEX.test(gradeId)) {
    return c.json({ error: 'missing_grade_id' }, 400)
  }

  const sessionId = event.data.object.id
  const row = await deps.store.getStripePaymentBySessionId(sessionId)
  if (!row) return c.json({ error: 'unknown_session' }, 400)
  if (row.status === 'paid') {
    return c.body(null, 200)  // idempotent
  }

  const amountCents = event.data.object.amount_total
  const currency = event.data.object.currency
  await deps.store.updateStripePaymentStatus(sessionId, {
    status: 'paid',
    ...(typeof amountCents === 'number' ? { amountCents } : {}),
    ...(typeof currency === 'string' ? { currency } : {}),
  })

  await deps.reportQueue.add(
    'generate-report',
    { gradeId, sessionId },
    { jobId: `generate-report:${sessionId}`, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
  )

  return c.body(null, 200)
})
```

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/server/routes/billing-webhook.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/server/routes/billing.ts tests/unit/server/routes/billing-webhook.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): POST /billing/webhook with signature verify + idempotency"
```

---

## Task 7: Extend GradeEvent union + subscribeToGrade iterator

**Files:**
- Modify: `src/queue/events.ts`
- Modify: `tests/unit/queue/events.test.ts` (existing file — add cases for `report.*` finish behavior)

- [ ] **Step 1: Write the failing test additions**

Append to `tests/unit/queue/events.test.ts` (inside the existing `describe` block):

```ts
it('iterator finishes on report.done', async () => {
  const redis = /* use existing test harness Redis */
  // ... existing pattern for subscribing + publishing
  // Publish: { type: 'report.done', reportId: '...' }
  // Assert: the async iterator yields the event then signals done: true on next()
})

it('iterator finishes on report.failed', async () => {
  // Similar
})
```

(Exact test code mirrors the pattern already in `events.test.ts` — copy the "iterator finishes on done" test and swap in `report.done` / `report.failed`.)

- [ ] **Step 2: Run — expect FAIL**

The `report.*` variant isn't in `GradeEvent` yet; the TypeScript compile will fail.

- [ ] **Step 3: Extend the `GradeEvent` union**

In `src/queue/events.ts`, replace the `GradeEvent` type with:

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
  | { type: 'done'; overall: number; letter: string; scores: Record<CategoryId, number | null> }
  | { type: 'failed'; error: string }
  // Plan 8 — paid-report pipeline
  | { type: 'report.started' }
  | {
      type: 'report.probe.started'
      category: CategoryId
      provider: ProviderId
      label: string
    }
  | {
      type: 'report.probe.completed'
      category: CategoryId
      provider: ProviderId
      label: string
      score: number | null
      durationMs: number
      error: string | null
    }
  | { type: 'report.recommendations.started' }
  | { type: 'report.recommendations.completed'; count: number }
  | { type: 'report.done'; reportId: string; token: string }
  | { type: 'report.failed'; error: string }
```

- [ ] **Step 4: Update the iterator's finish-condition**

In `subscribeToGrade`, change the finish check to:

```ts
if (
  event.type === 'done' ||
  event.type === 'failed' ||
  event.type === 'report.done' ||
  event.type === 'report.failed'
) finish()
```

- [ ] **Step 5: Run tests — expect PASS**

`pnpm test -- tests/unit/queue/events.test.ts`

- [ ] **Step 6: Full validation**

`pnpm test`, `pnpm typecheck` clean.

- [ ] **Step 7: Commit**

```bash
git add src/queue/events.ts tests/unit/queue/events.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(events): extend GradeEvent with report.* variants; iterator closes on report terminal"
```

---

## Task 8: Composite rescore helper

**Files:**
- Create: `src/scoring/rescore.ts`
- Test: `tests/unit/scoring/rescore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/scoring/rescore.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rescoreFromProbes } from '../../../src/scoring/rescore.ts'
import type { Probe } from '../../../src/store/types.ts'

function probe(overrides: Partial<Probe>): Probe {
  return {
    id: crypto.randomUUID(), gradeId: 'g1',
    category: 'recognition', provider: 'claude',
    prompt: 'p', response: 'r', score: 75,
    metadata: {}, createdAt: new Date(),
    ...overrides,
  }
}

describe('rescoreFromProbes', () => {
  it('aggregates per-category scores across providers', () => {
    const probes: Probe[] = [
      probe({ category: 'recognition', provider: 'claude', score: 80 }),
      probe({ category: 'recognition', provider: 'gpt', score: 90 }),
      probe({ category: 'recognition', provider: 'gemini', score: 70 }),
      probe({ category: 'recognition', provider: 'perplexity', score: 60 }),
      probe({ category: 'seo', provider: null, score: 85, metadata: { label: 'title' } }),
    ]
    const result = rescoreFromProbes(probes)
    expect(result.scores.recognition).toBe(75)  // mean of 80,90,70,60
    expect(result.scores.seo).toBe(85)
    expect(result.overall).toBeGreaterThan(0)
    expect(result.letter).toMatch(/^[A-F][+-]?$/)
  })

  it('uses latest row per (category, provider, label) for dedup', () => {
    const older = probe({ category: 'recognition', provider: 'claude', score: 50, createdAt: new Date(1000) })
    const newer = probe({ category: 'recognition', provider: 'claude', score: 90, createdAt: new Date(2000) })
    const result = rescoreFromProbes([older, newer])
    expect(result.scores.recognition).toBe(90)
  })

  it('returns null for categories with no probes', () => {
    const result = rescoreFromProbes([probe({ category: 'recognition', score: 80 })])
    expect(result.scores.citation).toBeNull()
    expect(result.scores.accuracy).toBeNull()
  })

  it('null-drop in overall: categories with null score are dropped', () => {
    const result = rescoreFromProbes([
      probe({ category: 'recognition', score: 100 }),
      probe({ category: 'seo', provider: null, score: 100, metadata: { label: 't' } }),
    ])
    // Only recognition (20%) + seo (10%) have scores; overall renormalizes.
    expect(result.overall).toBe(100)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `src/scoring/rescore.ts`**

```ts
import type { Probe } from '../store/types.ts'
import type { CategoryId } from './weights.ts'
import { DEFAULT_WEIGHTS } from './weights.ts'
import { weightedOverall, type CategoryScores } from './composite.ts'
import { toLetterGrade } from './letter.ts'

export interface RescoreResult {
  overall: number
  letter: string
  scores: Record<CategoryId, number | null>
}

export function rescoreFromProbes(probes: Probe[]): RescoreResult {
  // Dedup: newest createdAt wins per (category, provider, label).
  const keyFor = (p: Probe): string => {
    const label = typeof (p.metadata as { label?: string }).label === 'string'
      ? (p.metadata as { label: string }).label
      : p.category
    return `${p.category}:${p.provider ?? 'null'}:${label}`
  }
  const latest = new Map<string, Probe>()
  for (const p of probes) {
    const key = keyFor(p)
    const existing = latest.get(key)
    if (!existing || existing.createdAt.getTime() < p.createdAt.getTime()) {
      latest.set(key, p)
    }
  }

  const byCategory: Record<CategoryId, Probe[]> = {
    discoverability: [], recognition: [], accuracy: [], coverage: [], citation: [], seo: [],
  }
  for (const p of latest.values()) byCategory[p.category].push(p)

  const scores: Record<CategoryId, number | null> = {
    discoverability: null, recognition: null, accuracy: null,
    coverage: null, citation: null, seo: null,
  }
  for (const cat of Object.keys(byCategory) as CategoryId[]) {
    const rows = byCategory[cat].filter((p) => typeof p.score === 'number')
    if (rows.length === 0) continue
    const sum = rows.reduce((acc, p) => acc + (p.score as number), 0)
    scores[cat] = Math.round(sum / rows.length)
  }

  const categoryScores: CategoryScores = scores
  const { overall, letter } = weightedOverall(categoryScores, DEFAULT_WEIGHTS)
  return { overall, letter, scores }
}
```

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/scoring/rescore.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/scoring/rescore.ts tests/unit/scoring/rescore.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(scoring): add rescoreFromProbes pure helper"
```

---

## Task 9: Recommender LLM module

**Files:**
- Modify: `src/llm/prompts.ts` — add `promptRecommender(inputs): string`
- Create: `src/queue/workers/generate-report/recommender.ts`
- Test: `tests/unit/queue/workers/recommender.test.ts`

- [ ] **Step 1: Append to `src/llm/prompts.ts`**

```ts
export interface RecommenderInput {
  url: string
  scores: Record<string, number | null>
  failingSeoSignals: { label: string; detail: string }[]
  accuracyQuestion: string | null
  accuracyAnswers: { provider: string; response: string }[]
  llmDescriptions: { provider: string; description: string }[]
  scrapeText: string
}

export function promptRecommender(input: RecommenderInput): string {
  return `You are a GEO (Generative Engine Optimization) consultant reviewing how well LLMs know the website ${input.url}.

Here is the data we collected:

CATEGORY SCORES: ${JSON.stringify(input.scores)}

FAILING SEO SIGNALS:
${input.failingSeoSignals.map((s) => `- ${s.label}: ${s.detail}`).join('\n') || '(none)'}

ACCURACY:
${input.accuracyQuestion ? `Q: ${input.accuracyQuestion}` : '(no accuracy question)'}
${input.accuracyAnswers.map((a) => `  ${a.provider}: ${a.response}`).join('\n')}

LLM DESCRIPTIONS:
${input.llmDescriptions.map((d) => `  ${d.provider}: ${d.description}`).join('\n')}

SCRAPE (first 2000 chars):
${input.scrapeText.slice(0, 2000)}

Produce between 5 and 8 concrete recommendations as a JSON array. Each recommendation must be an object with these exact keys:
  - title (string, < 80 chars)
  - category (one of: discoverability, recognition, accuracy, coverage, citation, seo)
  - impact (integer 1-5 where 5 is highest)
  - effort (integer 1-5 where 5 is highest)
  - rationale (string, 1-3 sentences explaining why this helps)
  - how (string, 2-5 sentences describing concrete steps)

Respond with ONLY the JSON array. No prose, no code fences.`
}
```

- [ ] **Step 2: Write the recommender tests**

Create `tests/unit/queue/workers/recommender.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { runRecommender } from '../../../../src/queue/workers/generate-report/recommender.ts'

describe('runRecommender', () => {
  const baseInput = {
    gradeId: 'g1', url: 'https://x', scores: { recognition: 80 },
    failingSeoSignals: [], accuracyQuestion: null, accuracyAnswers: [],
    llmDescriptions: [], scrapeText: 'some text',
  }

  it('happy path: valid JSON with 5+ recs', async () => {
    const provider = { id: 'claude', query: vi.fn().mockResolvedValue({ text: JSON.stringify([
      { title: 'r1', category: 'recognition', impact: 5, effort: 2, rationale: 'r', how: 'h' },
      { title: 'r2', category: 'seo', impact: 4, effort: 2, rationale: 'r', how: 'h' },
      { title: 'r3', category: 'accuracy', impact: 3, effort: 3, rationale: 'r', how: 'h' },
      { title: 'r4', category: 'citation', impact: 2, effort: 1, rationale: 'r', how: 'h' },
      { title: 'r5', category: 'coverage', impact: 4, effort: 4, rationale: 'r', how: 'h' },
    ]) }) }
    const result = await runRecommender({ provider } as never, baseInput)
    expect(result.limited).toBe(false)
    expect(result.recommendations).toHaveLength(5)
    expect(result.attempts).toBe(1)
  })

  it('retry on invalid JSON: second call succeeds', async () => {
    const provider = { id: 'claude', query: vi.fn()
      .mockResolvedValueOnce({ text: 'NOT JSON' })
      .mockResolvedValueOnce({ text: JSON.stringify([
        { title: 'r1', category: 'recognition', impact: 5, effort: 2, rationale: 'r', how: 'h' },
        { title: 'r2', category: 'seo', impact: 4, effort: 2, rationale: 'r', how: 'h' },
        { title: 'r3', category: 'accuracy', impact: 3, effort: 3, rationale: 'r', how: 'h' },
        { title: 'r4', category: 'citation', impact: 2, effort: 1, rationale: 'r', how: 'h' },
        { title: 'r5', category: 'coverage', impact: 4, effort: 4, rationale: 'r', how: 'h' },
      ]) }),
    }
    const result = await runRecommender({ provider } as never, baseInput)
    expect(result.attempts).toBe(2)
    expect(result.limited).toBe(false)
  })

  it('retry on <5 recs: second call returns 6', async () => {
    const short = JSON.stringify([
      { title: 't', category: 'recognition', impact: 1, effort: 1, rationale: 'r', how: 'h' },
    ])
    const fine = JSON.stringify([
      { title: 'r1', category: 'recognition', impact: 5, effort: 2, rationale: 'r', how: 'h' },
      { title: 'r2', category: 'seo', impact: 4, effort: 2, rationale: 'r', how: 'h' },
      { title: 'r3', category: 'accuracy', impact: 3, effort: 3, rationale: 'r', how: 'h' },
      { title: 'r4', category: 'citation', impact: 2, effort: 1, rationale: 'r', how: 'h' },
      { title: 'r5', category: 'coverage', impact: 4, effort: 4, rationale: 'r', how: 'h' },
      { title: 'r6', category: 'discoverability', impact: 5, effort: 3, rationale: 'r', how: 'h' },
    ])
    const provider = { id: 'claude', query: vi.fn()
      .mockResolvedValueOnce({ text: short })
      .mockResolvedValueOnce({ text: fine }),
    }
    const result = await runRecommender({ provider } as never, baseInput)
    expect(result.recommendations).toHaveLength(6)
    expect(result.attempts).toBe(2)
  })

  it('both attempts fail: returns empty + limited=true', async () => {
    const provider = { id: 'claude', query: vi.fn().mockResolvedValue({ text: 'totally broken' }) }
    const result = await runRecommender({ provider } as never, baseInput)
    expect(result.recommendations).toHaveLength(0)
    expect(result.limited).toBe(true)
    expect(result.attempts).toBe(2)
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement `recommender.ts`**

Create `src/queue/workers/generate-report/recommender.ts`:

```ts
import { z } from 'zod'
import type { Provider } from '../../../llm/providers/types.ts'
import { promptRecommender, type RecommenderInput } from '../../../llm/prompts.ts'
import type { NewRecommendation } from '../../../store/types.ts'
import type { CategoryId } from '../../../scoring/weights.ts'

const VALID_CATEGORIES: readonly CategoryId[] = [
  'discoverability', 'recognition', 'accuracy', 'coverage', 'citation', 'seo',
] as const

const RecommendationSchema = z.object({
  title: z.string().min(1).max(80),
  category: z.enum(['discoverability', 'recognition', 'accuracy', 'coverage', 'citation', 'seo']),
  impact: z.number().int().min(1).max(5),
  effort: z.number().int().min(1).max(5),
  rationale: z.string().min(1),
  how: z.string().min(1),
})

const MIN_RECS = 5

export interface RecommenderDeps {
  provider: Provider
}

export interface RunRecommenderInput extends RecommenderInput {
  gradeId: string
}

export interface RunRecommenderResult {
  recommendations: NewRecommendation[]
  attempts: number
  limited: boolean
}

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '').trim()
}

function parseAndValidate(text: string): z.infer<typeof RecommendationSchema>[] | null {
  try {
    const parsed = JSON.parse(stripCodeFences(text))
    if (!Array.isArray(parsed)) return null
    const result: z.infer<typeof RecommendationSchema>[] = []
    for (const item of parsed) {
      const v = RecommendationSchema.safeParse(item)
      if (!v.success) return null
      result.push(v.data)
    }
    return result
  } catch { return null }
}

export async function runRecommender(
  deps: RecommenderDeps,
  input: RunRecommenderInput,
): Promise<RunRecommenderResult> {
  const prompt = promptRecommender(input)

  // Attempt 1.
  const first = await deps.provider.query({ prompt })
  const parsed1 = parseAndValidate(first.text)
  if (parsed1 && parsed1.length >= MIN_RECS) {
    return {
      recommendations: parsed1.map((r, i) => ({
        gradeId: input.gradeId, rank: i + 1,
        title: r.title, category: r.category,
        impact: r.impact, effort: r.effort, rationale: r.rationale, how: r.how,
      })),
      attempts: 1, limited: false,
    }
  }

  // Attempt 2: stricter prompt.
  const stricter = `${prompt}\n\nReturn AT LEAST ${MIN_RECS} recommendations. The response MUST be valid JSON — an array of objects matching the schema above. No prose, no code fences, no explanation.`
  const second = await deps.provider.query({ prompt: stricter })
  const parsed2 = parseAndValidate(second.text)
  if (parsed2 && parsed2.length >= MIN_RECS) {
    return {
      recommendations: parsed2.map((r, i) => ({
        gradeId: input.gradeId, rank: i + 1,
        title: r.title, category: r.category,
        impact: r.impact, effort: r.effort, rationale: r.rationale, how: r.how,
      })),
      attempts: 2, limited: false,
    }
  }

  // Both attempts failed.
  return { recommendations: [], attempts: 2, limited: true }
}
```

- [ ] **Step 5: Run — expect PASS**

`pnpm test -- tests/unit/queue/workers/recommender.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/llm/prompts.ts src/queue/workers/generate-report/recommender.ts tests/unit/queue/workers/recommender.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(recommender): add LLM recommender with Zod-validate and retry-once"
```

---

## Task 10: Delta-probe runner

**Files:**
- Create: `src/queue/workers/generate-report/probes.ts`
- Test: `tests/unit/queue/workers/delta-probes.test.ts`

**Context:** The delta-probe runner mirrors `run-grade/categories.ts` but only for Gemini + Perplexity, and it persists probes + publishes `report.probe.*` events (not regular `probe.*`). Existing per-category flow helpers in `src/llm/flows/*` and `src/accuracy/*` are reused unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/queue/workers/delta-probes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { runDeltaProbes } from '../../../../src/queue/workers/generate-report/probes.ts'
import type { ScrapeResult } from '../../../../src/scraper/types.ts'

const FIXTURE_SCRAPE: ScrapeResult = {
  rendered: false, html: '<html></html>',
  text: 'Acme widgets since 1902. Family-owned.'.repeat(20),
  structured: {
    jsonld: [], og: {}, meta: { title: 'Acme', description: '', canonical: 'https://acme.com', twitterCard: 'summary' },
    headings: { h1: ['Acme'], h2: [] }, robots: null, sitemap: { present: true, url: '' }, llmsTxt: { present: false, url: '' },
  },
}

describe('runDeltaProbes', () => {
  it('runs Gemini + Perplexity probes only; publishes report.probe events', async () => {
    const store = makeFakeStore()
    const grade = await store.createGrade({ url: 'https://acme.com', domain: 'acme.com', tier: 'free' })
    // Pre-seed Claude + GPT probes so the "only delta providers" assertion is meaningful
    await store.createProbe({
      gradeId: grade.id, category: 'recognition', provider: 'claude',
      prompt: 'p', response: 'r', score: 80, metadata: {},
    })
    await store.createProbe({
      gradeId: grade.id, category: 'recognition', provider: 'gpt',
      prompt: 'p', response: 'r', score: 70, metadata: {},
    })

    const gemini = new MockProvider({ id: 'gemini', responses: () => 'acme is a widget maker' })
    const perplexity = new MockProvider({ id: 'perplexity', responses: () => 'acme provides widgets' })
    const claude = new MockProvider({ id: 'claude', responses: () => 'some judge response' })

    const events: { type: string }[] = []
    const publish = vi.fn().mockImplementation(async (ev: { type: string }) => {
      events.push(ev)
    })

    await runDeltaProbes({
      store,
      providers: { gemini, perplexity, claudeForJudge: claude, generator: claude, verifier: claude },
      publishEvent: publish,
    }, { grade, scrape: FIXTURE_SCRAPE })

    const probes = await store.listProbes(grade.id)
    const deltaProbes = probes.filter((p) => p.provider === 'gemini' || p.provider === 'perplexity')
    expect(deltaProbes.length).toBeGreaterThan(0)
    // Claude + GPT probes are untouched (the 2 pre-seeded ones still exist)
    expect(probes.filter((p) => p.provider === 'claude').length).toBeGreaterThanOrEqual(1)

    // report.probe.started and report.probe.completed events were published
    expect(events.some((e) => e.type === 'report.probe.started')).toBe(true)
    expect(events.some((e) => e.type === 'report.probe.completed')).toBe(true)
  }, 30_000)
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `probes.ts`**

Create `src/queue/workers/generate-report/probes.ts`:

```ts
import type { GradeStore, Grade, NewProbe } from '../../../store/types.ts'
import type { Provider } from '../../../llm/providers/types.ts'
import type { ScrapeResult } from '../../../scraper/types.ts'
import type { GradeEvent } from '../../events.ts'
import type { CategoryId } from '../../../scoring/weights.ts'
import {
  promptRecognition, promptCoverageGenerator, promptCoverageProbe,
  promptCitation, promptDiscoverability,
} from '../../../llm/prompts.ts'
import { runStaticProbe } from '../../../llm/flows/static-probe.ts'
import { runSelfGenProbe } from '../../../llm/flows/self-gen-probe.ts'
import { runCoverageFlow } from '../../../llm/flows/coverage.ts'
import { runAccuracy } from '../../../accuracy/index.ts'

export interface DeltaProbeDeps {
  store: GradeStore
  providers: {
    gemini: Provider
    perplexity: Provider
    claudeForJudge: Provider
    generator: Provider
    verifier: Provider
  }
  publishEvent: (ev: GradeEvent) => Promise<void>
}

type ProberKey = 'gemini' | 'perplexity'

export async function runDeltaProbes(
  deps: DeltaProbeDeps,
  input: { grade: Grade; scrape: ScrapeResult },
): Promise<void> {
  const probers: { key: ProberKey; provider: Provider }[] = [
    { key: 'gemini', provider: deps.providers.gemini },
    { key: 'perplexity', provider: deps.providers.perplexity },
  ]

  for (const { key, provider } of probers) {
    // Recognition
    await runProbe(deps, {
      grade: input.grade, provider, providerId: key,
      category: 'recognition', label: 'description',
      run: () => runStaticProbe(provider, promptRecognition(input.grade.url)),
    })

    // Coverage — 4 queries generated from the scrape
    const coverageQueries = await runCoverageFlow(deps.providers.claudeForJudge, {
      url: input.grade.url, scrape: input.scrape,
    })
    for (const query of coverageQueries) {
      await runProbe(deps, {
        grade: input.grade, provider, providerId: key,
        category: 'coverage', label: query.slice(0, 60),
        run: () => runStaticProbe(provider, promptCoverageProbe(query)),
      })
    }

    // Citation — 2 queries
    for (const label of ['site_name', 'domain']) {
      await runProbe(deps, {
        grade: input.grade, provider, providerId: key,
        category: 'citation', label,
        run: () => runStaticProbe(provider, promptCitation(input.grade.url, label)),
      })
    }

    // Discoverability — 2 self-gen queries
    for (const i of [1, 2]) {
      await runProbe(deps, {
        grade: input.grade, provider, providerId: key,
        category: 'discoverability', label: `self_query_${i}`,
        run: () => runSelfGenProbe(provider, input.grade.url),
      })
    }

    // Accuracy — add this provider's prober to the accuracy flow.
    await runAccuracy({
      store: deps.store, grade: input.grade, scrape: input.scrape,
      generator: deps.providers.generator, verifier: deps.providers.verifier,
      probers: [{ id: key, provider }],
      publishEvent: async (ev) => deps.publishEvent(adaptToReportProbe(ev)),
    })
  }
}

interface RunProbeArgs {
  grade: Grade
  provider: Provider
  providerId: ProberKey
  category: CategoryId
  label: string
  run: () => Promise<{ response: string; score: number | null }>
}

async function runProbe(deps: DeltaProbeDeps, args: RunProbeArgs): Promise<void> {
  const started = Date.now()
  await deps.publishEvent({
    type: 'report.probe.started',
    category: args.category, provider: args.providerId, label: args.label,
  })
  try {
    const result = await args.run()
    const durationMs = Date.now() - started
    const row: NewProbe = {
      gradeId: args.grade.id, category: args.category, provider: args.providerId,
      prompt: `[delta-probe ${args.category} ${args.label}]`,
      response: result.response, score: result.score, metadata: { label: args.label },
    }
    await deps.store.createProbe(row)
    await deps.publishEvent({
      type: 'report.probe.completed',
      category: args.category, provider: args.providerId, label: args.label,
      score: result.score, durationMs, error: null,
    })
  } catch (err) {
    const durationMs = Date.now() - started
    await deps.publishEvent({
      type: 'report.probe.completed',
      category: args.category, provider: args.providerId, label: args.label,
      score: null, durationMs, error: err instanceof Error ? err.message : String(err),
    })
  }
}

function adaptToReportProbe(ev: GradeEvent): GradeEvent {
  if (ev.type === 'probe.started' && ev.provider !== null && ev.provider !== 'mock') {
    return { type: 'report.probe.started', category: ev.category, provider: ev.provider, label: ev.label }
  }
  if (ev.type === 'probe.completed' && ev.provider !== null && ev.provider !== 'mock') {
    return {
      type: 'report.probe.completed', category: ev.category, provider: ev.provider, label: ev.label,
      score: ev.score, durationMs: ev.durationMs, error: ev.error,
    }
  }
  return ev
}
```

**NOTE for the implementer:** the exact signatures of `runStaticProbe`, `runSelfGenProbe`, `runCoverageFlow`, `runAccuracy` may differ slightly from the sketch above. Adapt the calls to match the real function signatures in the codebase — don't change their internals. If a signature mismatch requires a deeper change, stop and escalate.

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/queue/workers/delta-probes.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/queue/workers/generate-report/probes.ts tests/unit/queue/workers/delta-probes.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(generate-report): add delta-probe runner for Gemini + Perplexity"
```

---

## Task 11: generate-report Processor + worker registration

**Files:**
- Create: `src/queue/workers/generate-report/deps.ts`
- Create: `src/queue/workers/generate-report/generate-report.ts`
- Create: `src/queue/workers/generate-report/index.ts`
- Test: `tests/unit/queue/workers/generate-report.test.ts`

- [ ] **Step 1: Write `deps.ts`**

```ts
import type { GradeStore } from '../../../store/types.ts'
import type Redis from 'ioredis'
import type { Provider } from '../../../llm/providers/types.ts'
import type { runRecommender } from './recommender.ts'

export interface GenerateReportDeps {
  store: GradeStore
  redis: Redis
  providers: {
    claude: Provider; gpt: Provider; gemini: Provider; perplexity: Provider
  }
  recommenderFn: typeof runRecommender
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/queue/workers/generate-report.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { generateReport } from '../../../../src/queue/workers/generate-report/generate-report.ts'

async function seedFreeGrade(store: ReturnType<typeof makeFakeStore>) {
  const grade = await store.createGrade({
    url: 'https://acme.com', domain: 'acme.com', tier: 'free', status: 'done',
    overall: 70, letter: 'C', scores: { recognition: 80, seo: 80, accuracy: 50, coverage: 70, citation: 70, discoverability: 60 },
  })
  await store.createScrape({
    gradeId: grade.id, rendered: false, html: '<html>Acme widgets</html>',
    text: 'Acme widgets since 1902. '.repeat(20),
    structured: { jsonld: [], og: {}, meta: {}, headings: {}, robots: null, sitemap: {}, llmsTxt: {} } as never,
  })
  await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'claude', prompt: 'p', response: 'acme widgets', score: 80, metadata: {} })
  await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'gpt', prompt: 'p', response: 'acme widgets', score: 70, metadata: {} })
  return grade
}

const fakeRecommender = async (deps: never, input: { gradeId: string }) => ({
  recommendations: [1, 2, 3, 4, 5].map((rank) => ({
    gradeId: input.gradeId, rank,
    title: `r${rank}`, category: 'recognition' as const,
    impact: 4, effort: 2, rationale: 'r', how: 'h',
  })),
  attempts: 1, limited: false,
})

const makeRedis = () => ({ publish: vi.fn().mockResolvedValue(undefined) })

describe('generateReport', () => {
  it('happy path: tier flips to paid, recommendations + report row written, events published', async () => {
    const store = makeFakeStore()
    const grade = await seedFreeGrade(store)
    const redis = makeRedis()
    const generic = new MockProvider({ id: 'mock', responses: () => 'ok' })
    await generateReport({
      store,
      redis: redis as never,
      providers: {
        claude: generic, gpt: generic,
        gemini: new MockProvider({ id: 'gemini', responses: () => 'acme widget' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => 'acme widget' }),
      },
      recommenderFn: fakeRecommender as never,
    }, { gradeId: grade.id, sessionId: 'cs_test' })

    const updated = await store.getGrade(grade.id)
    expect(updated!.tier).toBe('paid')
    const recs = await store.listRecommendations(grade.id)
    expect(recs.length).toBeGreaterThanOrEqual(5)
    const report = await store.getReport(grade.id)
    expect(report).not.toBeNull()
    expect(report!.token).toMatch(/^[0-9a-f]{64}$/)

    const published = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as { type: string })
    const types = published.map((e) => e.type)
    expect(types[0]).toBe('report.started')
    expect(types).toContain('report.probe.started')
    expect(types).toContain('report.probe.completed')
    expect(types).toContain('report.recommendations.started')
    expect(types).toContain('report.recommendations.completed')
    expect(types[types.length - 1]).toBe('report.done')
  }, 60_000)

  it('tier flip is LAST: throw right before tier flip leaves tier=free', async () => {
    const store = makeFakeStore()
    const grade = await seedFreeGrade(store)
    const redis = makeRedis()
    const generic = new MockProvider({ id: 'mock', responses: () => 'ok' })
    // Recommender throws after rec rows persist but the test inspects after.
    // We simulate a late failure by poisoning createReport.
    const originalCreateReport = store.createReport.bind(store)
    store.createReport = vi.fn().mockRejectedValue(new Error('simulated'))

    await expect(generateReport({
      store, redis: redis as never,
      providers: {
        claude: generic, gpt: generic,
        gemini: new MockProvider({ id: 'gemini', responses: () => 'g' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => 'p' }),
      },
      recommenderFn: fakeRecommender as never,
    }, { gradeId: grade.id, sessionId: 'cs_test' })).rejects.toThrow('simulated')

    const updated = await store.getGrade(grade.id)
    expect(updated!.tier).toBe('free')
    store.createReport = originalCreateReport
  }, 60_000)

  it('limited recommendations: grade.scores.metadata.recommendationsLimited=true', async () => {
    const store = makeFakeStore()
    const grade = await seedFreeGrade(store)
    const redis = makeRedis()
    const generic = new MockProvider({ id: 'mock', responses: () => 'ok' })
    const limitedRecommender = async () => ({ recommendations: [], attempts: 2, limited: true })
    await generateReport({
      store, redis: redis as never,
      providers: {
        claude: generic, gpt: generic,
        gemini: new MockProvider({ id: 'gemini', responses: () => 'g' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => 'p' }),
      },
      recommenderFn: limitedRecommender as never,
    }, { gradeId: grade.id, sessionId: 'cs_test' })

    const updated = await store.getGrade(grade.id)
    expect(updated!.tier).toBe('paid')
    const scores = updated!.scores as { metadata?: { recommendationsLimited?: boolean } }
    expect(scores.metadata?.recommendationsLimited).toBe(true)
  }, 60_000)
})
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement `generate-report.ts`**

Create `src/queue/workers/generate-report/generate-report.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { publishGradeEvent } from '../../events.ts'
import { rescoreFromProbes } from '../../../scoring/rescore.ts'
import { runDeltaProbes } from './probes.ts'
import type { GenerateReportDeps } from './deps.ts'

export interface GenerateReportJob { gradeId: string; sessionId: string }

export async function generateReport(
  deps: GenerateReportDeps,
  job: GenerateReportJob,
): Promise<void> {
  const { gradeId } = job
  const publish = (ev: Parameters<typeof publishGradeEvent>[2]): Promise<void> =>
    publishGradeEvent(deps.redis, gradeId, ev)

  await publish({ type: 'report.started' })

  const grade = await deps.store.getGrade(gradeId)
  if (!grade) throw new Error(`generateReport: grade ${gradeId} not found`)
  if (grade.status !== 'done') throw new Error(`generateReport: grade ${gradeId} status=${grade.status}`)
  if (grade.tier !== 'free') throw new Error(`generateReport: grade ${gradeId} tier=${grade.tier}`)

  const scrape = await deps.store.getScrape(gradeId)
  if (!scrape) throw new Error(`generateReport: scrape for ${gradeId} not found`)

  // 1. Delta probes (Gemini + Perplexity)
  await runDeltaProbes({
    store: deps.store,
    providers: {
      gemini: deps.providers.gemini,
      perplexity: deps.providers.perplexity,
      claudeForJudge: deps.providers.claude,
      generator: deps.providers.claude,
      verifier: deps.providers.claude,
    },
    publishEvent: publish,
  }, { grade, scrape: { ...scrape, rendered: scrape.rendered, html: scrape.html, text: scrape.text, structured: scrape.structured as never } })

  // 2. Recompute composite scores from all 4 providers' probes
  const allProbes = await deps.store.listProbes(gradeId)
  const rescored = rescoreFromProbes(allProbes)

  // 3. Recommendation LLM
  await publish({ type: 'report.recommendations.started' })
  const seoFailingSignals = allProbes
    .filter((p) => p.category === 'seo' && p.score !== null && p.score < 100)
    .map((p) => ({
      label: String((p.metadata as { label?: string }).label ?? 'unknown'),
      detail: p.response,
    }))
  const accuracyProbes = allProbes.filter((p) => p.category === 'accuracy' && p.provider === null)
  const accuracyAnswerProbes = allProbes.filter((p) => p.category === 'accuracy' && p.provider !== null)
  const llmDescriptions = allProbes
    .filter((p) => p.category === 'recognition')
    .map((p) => ({ provider: p.provider ?? 'unknown', description: p.response }))

  const recResult = await deps.recommenderFn({ provider: deps.providers.claude }, {
    gradeId,
    url: grade.url,
    scores: rescored.scores,
    failingSeoSignals: seoFailingSignals,
    accuracyQuestion: accuracyProbes[0]?.response ?? null,
    accuracyAnswers: accuracyAnswerProbes.map((p) => ({ provider: p.provider ?? 'unknown', response: p.response })),
    llmDescriptions,
    scrapeText: scrape.text,
  })
  if (recResult.recommendations.length > 0) {
    await deps.store.createRecommendations(recResult.recommendations)
  }
  await publish({ type: 'report.recommendations.completed', count: recResult.recommendations.length })

  // 4. Write reports row
  const token = randomBytes(32).toString('hex')
  const report = await deps.store.createReport({ gradeId, token })

  // 5. Update grade: new scores + tier='paid' (LAST writes)
  const existingScores = (grade.scores as { metadata?: Record<string, unknown> } | null) ?? {}
  const newScores: Record<string, unknown> = {
    ...rescored.scores,
    metadata: {
      ...(existingScores.metadata ?? {}),
      ...(recResult.limited ? { recommendationsLimited: true } : {}),
    },
  }
  await deps.store.updateGrade(gradeId, {
    overall: rescored.overall,
    letter: rescored.letter,
    scores: newScores as never,
  })
  // tier flip is the very last write — separately so a crash here can be detected
  await deps.store.updateGrade(gradeId, { status: 'done', scores: newScores as never } as never)
  // Note: 'tier' isn't in the default GradeUpdate subset; see Task 11 follow-up.

  await publish({ type: 'report.done', reportId: report.id, token })
}
```

**NOTE for the implementer:** `GradeUpdate` in `src/store/types.ts` currently doesn't include `tier`. Extend it to `Partial<Pick<Grade, 'status' | 'overall' | 'letter' | 'scores' | 'cookie' | 'userId' | 'tier'>>` as part of this task. Update `PostgresStore.updateGrade` / `FakeStore.updateGrade` if needed to accept it. After the tier is addable, the final write becomes:

```ts
await deps.store.updateGrade(gradeId, { tier: 'paid' })
```

(Replace the second `updateGrade` call above with this once the type is extended.)

- [ ] **Step 5: Write `index.ts`**

```ts
import { Worker } from 'bullmq'
import type Redis from 'ioredis'
import { reportQueueName, type ReportJob } from '../../queues.ts'
import { generateReport, type GenerateReportJob } from './generate-report.ts'
import { runRecommender } from './recommender.ts'
import type { GenerateReportDeps } from './deps.ts'

type JobDataInput = Pick<GenerateReportJob, 'gradeId' | 'sessionId'>

export function registerGenerateReportWorker(
  deps: Omit<GenerateReportDeps, 'recommenderFn'>,
  connection: Redis,
): Worker<ReportJob> {
  const fullDeps: GenerateReportDeps = { ...deps, recommenderFn: runRecommender }
  return new Worker<ReportJob>(
    reportQueueName,
    async (job) => {
      const data = job.data as JobDataInput
      await generateReport(fullDeps, data)
    },
    { connection, concurrency: 1 },
  )
}
```

- [ ] **Step 6: Extend `GradeUpdate` to include tier (small type change)**

In `src/store/types.ts`:

```ts
export type GradeUpdate = Partial<Pick<Grade, 'status' | 'overall' | 'letter' | 'scores' | 'cookie' | 'userId' | 'tier'>>
```

Then update the second `updateGrade` call in `generate-report.ts` (see Step 4 NOTE).

- [ ] **Step 7: Run — expect PASS**

`pnpm test -- tests/unit/queue/workers/generate-report.test.ts`
Expected: 3 tests pass.

- [ ] **Step 8: Full validation**

`pnpm test`, `pnpm typecheck` clean.

- [ ] **Step 9: Commit**

```bash
git add src/queue/workers/generate-report/ src/store/types.ts tests/unit/queue/workers/generate-report.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(worker): add generate-report worker (delta probes + rescore + recommender + tier flip)"
```

---

## Task 12: Wire billing + reportQueue into ServerDeps + worker entrypoint

**Files:**
- Modify: `src/server/deps.ts` (add `billing`, `priceId`, `webhookSecret`, `reportQueue`)
- Modify: `src/server/app.ts` (mount /billing sub-app)
- Modify: `src/server/server.ts` (instantiate BillingClient + reportQueue)
- Modify: `src/worker/worker.ts` (register generate-report worker)
- Modify: test files that construct `ServerDeps` (fallout)

- [ ] **Step 1: Update `ServerDeps`**

In `src/server/deps.ts`:

```ts
import type Redis from 'ioredis'
import type { Queue } from 'bullmq'
import type { GradeStore } from '../store/types.ts'
import type { Mailer } from '../mail/types.ts'
import type { BillingClient } from '../billing/types.ts'
import type { ReportJob } from '../queue/queues.ts'

export interface ServerDeps {
  store: GradeStore
  redis: Redis
  redisFactory: () => Redis
  mailer: Mailer
  billing: BillingClient | null
  reportQueue: Queue<ReportJob>
  pingDb: () => Promise<boolean>
  pingRedis: () => Promise<boolean>
  env: {
    NODE_ENV: 'development' | 'test' | 'production'
    COOKIE_HMAC_KEY: string
    PUBLIC_BASE_URL: string
    STRIPE_PRICE_ID: string | null
    STRIPE_WEBHOOK_SECRET: string | null
  }
}
```

(`billing` + the two Stripe env fields can be `null` in dev when unconfigured; the route handlers will 503 in that case.)

- [ ] **Step 2: Mount /billing in `src/server/app.ts`**

Import:
```ts
import { billingRouter } from './routes/billing.ts'
```

After the `authScope` mount and BEFORE the production `serveStatic` block:

```ts
if (deps.billing && deps.env.STRIPE_PRICE_ID && deps.env.STRIPE_WEBHOOK_SECRET) {
  const billing = deps.billing
  const priceId = deps.env.STRIPE_PRICE_ID
  const webhookSecret = deps.env.STRIPE_WEBHOOK_SECRET
  const billingScope = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  // Cookie middleware only on /checkout; webhook explicitly skips it.
  billingScope.use('/checkout', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  billingScope.route('/', billingRouter({
    store: deps.store, billing, priceId, publicBaseUrl: deps.env.PUBLIC_BASE_URL,
    webhookSecret, reportQueue: deps.reportQueue,
  }))
  app.route('/billing', billingScope)
} else {
  app.post('/billing/checkout', (c) => c.json({ error: 'stripe_not_configured' }, 503))
  app.post('/billing/webhook', (c) => c.json({ error: 'stripe_not_configured' }, 503))
  if (deps.env.NODE_ENV !== 'test') {
    console.warn('Stripe not configured — /billing endpoints return 503. Set STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET/STRIPE_PRICE_ID.')
  }
}
```

- [ ] **Step 3: Update `src/server/server.ts`**

Add imports:
```ts
import { StripeBillingClient } from '../billing/stripe-client.ts'
import { getReportQueue } from '../queue/queues.ts'
```

Replace the existing `buildApp({...})` block with:

```ts
const billing = env.STRIPE_SECRET_KEY
  ? new StripeBillingClient({ secretKey: env.STRIPE_SECRET_KEY })
  : null
const reportQueue = getReportQueue(redis)

const app = buildApp({
  store, redis,
  redisFactory: () => createRedis(env.REDIS_URL),
  mailer,
  billing,
  reportQueue,
  pingDb: async () => {
    try { await db.execute(sql`select 1`); return true } catch { return false }
  },
  pingRedis: async () => (await redis.ping()) === 'PONG',
  env: {
    NODE_ENV: env.NODE_ENV,
    COOKIE_HMAC_KEY: cookieHmacKey,
    PUBLIC_BASE_URL: publicBaseUrl,
    STRIPE_PRICE_ID: env.STRIPE_PRICE_ID ?? null,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET ?? null,
  },
})
```

- [ ] **Step 4: Update `src/worker/worker.ts`**

Add imports:
```ts
import { registerGenerateReportWorker } from '../queue/workers/generate-report/index.ts'
```

In the `const workers = [...]` array, append:
```ts
registerGenerateReportWorker(
  { store, redis: connection, providers },
  connection,
),
```

- [ ] **Step 5: Fix broken tests (fallout)**

`pnpm typecheck` will flag test files constructing `ServerDeps`. Expected broken files (based on Plan 7's fallout list):

- `tests/unit/server/healthz.test.ts`
- `tests/unit/server/routes/grades.test.ts`
- `tests/unit/server/routes/grades-events.test.ts`
- `tests/integration/healthz.test.ts`
- `tests/integration/grades-events-live-full-run.test.ts`
- `tests/integration/grades-events-live-reconnect.test.ts`

Each has a deps literal shaped roughly like the Plan 7 shape (`store`, `redis`, `redisFactory`, `mailer`, `pingDb`, `pingRedis`, `env: { NODE_ENV, COOKIE_HMAC_KEY, PUBLIC_BASE_URL }`). For each, add:

1. Import: `import { Queue } from 'bullmq'`.
2. Add two new fields to the deps literal — `billing: null` and `reportQueue: {} as Queue`.
3. Extend the `env` block with `STRIPE_PRICE_ID: null` and `STRIPE_WEBHOOK_SECRET: null`.

Example before:
```ts
const deps: ServerDeps = {
  store,
  redis,
  redisFactory: () => redis,
  mailer: new FakeMailer(),
  pingDb: async () => true,
  pingRedis: async () => true,
  env: {
    NODE_ENV: 'test',
    COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
    PUBLIC_BASE_URL: 'http://localhost:5173',
  },
}
```

Example after:
```ts
const deps: ServerDeps = {
  store,
  redis,
  redisFactory: () => redis,
  mailer: new FakeMailer(),
  billing: null,
  reportQueue: {} as Queue,
  pingDb: async () => true,
  pingRedis: async () => true,
  env: {
    NODE_ENV: 'test',
    COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
    PUBLIC_BASE_URL: 'http://localhost:5173',
    STRIPE_PRICE_ID: null,
    STRIPE_WEBHOOK_SECRET: null,
  },
}
```

Cast `{} as Queue` is safe because those tests don't exercise the `/billing` routes and never call the queue.

- [ ] **Step 6: Full validation**

```
pnpm test
pnpm test:integration
pnpm typecheck
pnpm build
```

All must pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/deps.ts src/server/app.ts src/server/server.ts src/worker/worker.ts \
        $(git ls-files -m tests/)
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): wire BillingClient + reportQueue into app and workers"
```

---

## Task 13: SSE endpoint hydration for paid-tier probes

**Files:**
- Modify: `src/server/routes/grades-events.ts`
- Test: `tests/integration/grades-events-report-hydration.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/grades-events-report-hydration.test.ts`. Pattern: spin up the real app via `serve`, seed a tier='paid' grade with Gemini + Perplexity probes + a reports row, connect to `/events`, assert the SSE stream emits synthesized `report.probe.completed` events for each delta probe plus a `report.done` event.

Use `tests/integration/grades-events-live-full-run.test.ts` as the template for the real-HTTP harness (real testcontainers Redis + Postgres + `serve()` + the Response body reader pattern).

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Extend `src/server/routes/grades-events.ts`**

Locate the hydration block (where existing probes → `probe.completed` events are synthesized). Extend it:

```ts
// Existing: for each free-tier probe row, synthesize probe.completed.
// New: for each probe with provider in {'gemini', 'perplexity'}, synthesize report.probe.completed instead.
for (const probe of probes) {
  const isPaidTier = probe.provider === 'gemini' || probe.provider === 'perplexity'
  const label = typeof (probe.metadata as { label?: string }).label === 'string'
    ? (probe.metadata as { label: string }).label
    : probe.category
  if (isPaidTier) {
    yield {
      type: 'report.probe.completed',
      category: probe.category,
      provider: probe.provider as 'gemini' | 'perplexity',
      label,
      score: probe.score,
      durationMs: 0,
      error: null,
    }
  } else {
    yield {
      type: 'probe.completed',
      category: probe.category,
      provider: probe.provider,
      label,
      score: probe.score,
      durationMs: 0,
      error: null,
    }
  }
}

// If tier='paid' and report row exists: emit report.done as the terminal event
if (grade.tier === 'paid') {
  const report = await deps.store.getReport(gradeId)
  if (report) {
    yield { type: 'report.done', reportId: report.id, token: report.token }
    return  // terminate the generator — no live subscribe needed
  }
}
```

Adapt the snippet above to the existing generator/closure style of `grades-events.ts`. Don't restructure the file; just extend the existing hydration + terminal-event logic.

- [ ] **Step 4: Run — expect PASS**

`pnpm test:integration -- tests/integration/grades-events-report-hydration.test.ts`

- [ ] **Step 5: Full validation**

`pnpm test:integration` all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/grades-events.ts tests/integration/grades-events-report-hydration.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(sse): hydrate report.probe.completed + report.done on reconnect for paid grades"
```

---

## Task 14: Integration tests — billing webhook + generate-report lifecycle

**Files:**
- Create: `tests/integration/billing-webhook.test.ts`
- Create: `tests/integration/generate-report-lifecycle.test.ts`

- [ ] **Step 1: Write `tests/integration/billing-webhook.test.ts`**

Same testcontainers pattern as Plan 7's auth-magic-link.test.ts. Inject a real `StripeBillingClient` with a known webhook secret (we control it since we generated the event). Actually — since we're constructing signed events locally, we can keep using `FakeStripe` here too. Use FakeStripe; the spec's §10.2 says integration tests use the real SDK's helpers, but FakeStripe implements the exact same signing scheme so it's functionally equivalent.

Two test cases:
1. Real-webhook-through-the-app: construct a signed event via FakeStripe, POST to the real `/billing/webhook` built by `buildApp`, assert DB state + that a BullMQ job was enqueued in the `report` queue.
2. Duplicate webhook: POST the same event twice, assert the second call doesn't double-enqueue.

- [ ] **Step 2: Write `tests/integration/generate-report-lifecycle.test.ts`**

Seed the DB with a `tier='free'` grade + scrape + Claude/GPT probes (like run-grade would leave). Enqueue a `generate-report` job directly to the `report` BullMQ queue with `{ gradeId, sessionId }`. Wait for the job to complete (BullMQ's `waitUntilFinished`). Assert:
- `grades.tier === 'paid'`
- `probes` table has rows for Gemini + Perplexity
- `recommendations` table has ≥ 5 rows
- `reports` table has 1 row with a 64-char hex token
- `grades.overall` / `grades.letter` / `grades.scores` are recomputed

- [ ] **Step 3: Run — expect PASS**

```
pnpm test:integration -- tests/integration/billing-webhook.test.ts tests/integration/generate-report-lifecycle.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add tests/integration/billing-webhook.test.ts tests/integration/generate-report-lifecycle.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(billing): integration tests for webhook + generate-report lifecycle"
```

---

## Task 15: Frontend — extend GradeEvent + reducer + api.ts

**Files:**
- Modify: `src/web/lib/types.ts` — extend GradeEvent union; add paidStatus to GradeState
- Modify: `src/web/lib/grade-reducer.ts` — handle report.* events
- Modify: `src/web/lib/api.ts` — add postBillingCheckout
- Modify: `tests/unit/web/grade-reducer.test.ts` — add report.* test cases

- [ ] **Step 1: Extend types**

Update `src/web/lib/types.ts` `GradeEvent` union to mirror the backend (copy from `src/queue/events.ts`). Add to `GradeState`:

```ts
export type PaidStatus = 'none' | 'checking_out' | 'generating' | 'ready' | 'failed'

export interface GradeState {
  phase: Phase
  scraped: { rendered: boolean; textLength: number } | null
  probes: Map<string, ProbeEntry>
  categoryScores: Record<CategoryId, number | null>
  overall: number | null
  letter: string | null
  error: string | null
  paidStatus: PaidStatus
  reportToken: string | null
  reportId: string | null
}
```

- [ ] **Step 2: Write reducer test additions**

Append to `tests/unit/web/grade-reducer.test.ts`:

```ts
describe('grade-reducer — paid flow', () => {
  it('report.started transitions paidStatus to generating', () => {
    let state = initialGradeState()
    state = reduceGradeEvents(state, { type: 'report.started' }, 0)
    expect(state.paidStatus).toBe('generating')
  })

  it('report.probe.completed adds to probes map', () => {
    let state = initialGradeState()
    state = reduceGradeEvents(state, {
      type: 'report.probe.completed',
      category: 'recognition', provider: 'gemini', label: 'description',
      score: 80, durationMs: 1000, error: null,
    }, 0)
    expect([...state.probes.values()].some((p) => p.provider === 'gemini')).toBe(true)
  })

  it('report.done sets paidStatus=ready + reportToken + reportId', () => {
    let state = initialGradeState()
    state = reduceGradeEvents(state, { type: 'report.done', reportId: 'r-1', token: 'abc' }, 0)
    expect(state.paidStatus).toBe('ready')
    expect(state.reportToken).toBe('abc')
    expect(state.reportId).toBe('r-1')
  })

  it('report.failed sets paidStatus=failed + error', () => {
    let state = initialGradeState()
    state = reduceGradeEvents(state, { type: 'report.failed', error: 'boom' }, 0)
    expect(state.paidStatus).toBe('failed')
    expect(state.error).toBe('boom')
  })
})
```

(Use whatever `initialGradeState` helper already exists in the reducer test file; if not present, construct the initial state inline.)

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Extend `reduceGradeEvents`**

In `src/web/lib/grade-reducer.ts`, add cases for the new event types:

```ts
case 'report.started':
  return { ...state, paidStatus: 'generating' }
case 'report.probe.started': {
  const key = `${event.category}:${event.provider}:${event.label}`
  const entry: ProbeEntry = {
    key, category: event.category, provider: event.provider, label: event.label,
    status: 'started', score: null, durationMs: 0, error: null, startedAt: now,
  }
  const probes = new Map(state.probes)
  probes.set(key, entry)
  return { ...state, probes }
}
case 'report.probe.completed': {
  const key = `${event.category}:${event.provider}:${event.label}`
  const existing = state.probes.get(key)
  const entry: ProbeEntry = {
    key, category: event.category, provider: event.provider, label: event.label,
    status: 'completed', score: event.score, durationMs: event.durationMs,
    error: event.error, startedAt: existing?.startedAt ?? now,
  }
  const probes = new Map(state.probes)
  probes.set(key, entry)
  return { ...state, probes }
}
case 'report.recommendations.started':
case 'report.recommendations.completed':
  return state  // informational only; no state change
case 'report.done':
  return { ...state, paidStatus: 'ready', reportId: event.reportId, reportToken: event.token }
case 'report.failed':
  return { ...state, paidStatus: 'failed', error: event.error }
```

Also update `initialGradeState` (or its equivalent) to initialize `paidStatus: 'none'`, `reportToken: null`, `reportId: null`.

- [ ] **Step 5: Append to `src/web/lib/api.ts`**

```ts
export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; kind: 'already_paid'; reportId: string }
  | { ok: false; kind: 'grade_not_done' }
  | { ok: false; kind: 'unavailable' }    // 503 / stripe not configured
  | { ok: false; kind: 'unknown'; status: number }

export async function postBillingCheckout(gradeId: string): Promise<CheckoutResult> {
  let res: Response
  try {
    res = await fetch('/billing/checkout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gradeId }),
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }

  if (res.status === 200) {
    const body = await res.json() as { url: string }
    return { ok: true, url: body.url }
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reportId?: string }
    if (body.error === 'already_paid' && typeof body.reportId === 'string') {
      return { ok: false, kind: 'already_paid', reportId: body.reportId }
    }
    if (body.error === 'grade_not_done') return { ok: false, kind: 'grade_not_done' }
    return { ok: false, kind: 'unknown', status: res.status }
  }
  if (res.status === 503) return { ok: false, kind: 'unavailable' }
  return { ok: false, kind: 'unknown', status: res.status }
}
```

- [ ] **Step 6: Run — expect PASS**

`pnpm test -- tests/unit/web/grade-reducer.test.ts`

- [ ] **Step 7: Full validation + commit**

```bash
git add src/web/lib/types.ts src/web/lib/grade-reducer.ts src/web/lib/api.ts tests/unit/web/grade-reducer.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): extend GradeEvent + reducer with report.* + add postBillingCheckout"
```

---

## Task 16: Frontend — BuyReportButton + PaidReportStatus + CheckoutCanceledToast

**Files:**
- Create: `src/web/components/BuyReportButton.tsx`
- Create: `src/web/components/PaidReportStatus.tsx`
- Create: `src/web/components/CheckoutCanceledToast.tsx`
- Test: `tests/unit/web/components/BuyReportButton.test.tsx`
- Test: `tests/unit/web/components/PaidReportStatus.test.tsx`

- [ ] **Step 1: Write `BuyReportButton.tsx`**

```tsx
import React, { useState } from 'react'
import { postBillingCheckout } from '../lib/api.ts'

interface BuyReportButtonProps {
  gradeId: string
  onAlreadyPaid: (reportId: string) => void
}

export function BuyReportButton({ gradeId, onAlreadyPaid }: BuyReportButtonProps): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick(): Promise<void> {
    setPending(true); setError(null)
    const result = await postBillingCheckout(gradeId)
    if (result.ok) {
      window.location.assign(result.url)
      return
    }
    setPending(false)
    if (result.kind === 'already_paid') { onAlreadyPaid(result.reportId); return }
    if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
    if (result.kind === 'unavailable') { setError('Checkout is temporarily unavailable.'); return }
    setError('Something went wrong. Try again?')
  }

  return (
    <div className="mt-6 border border-[var(--color-brand)] p-4">
      <div className="text-sm text-[var(--color-fg)] mb-3">
        Unlock the full report — 4 LLM providers, 5-8 concrete recommendations, HTML + PDF.
      </div>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={pending}
        className="bg-[var(--color-brand)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
      >
        {pending ? '...' : 'Get the full report — $19'}
      </button>
      {error !== null && <div className="text-xs text-[var(--color-warn)] mt-2">{error}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Write `PaidReportStatus.tsx`**

```tsx
import React from 'react'
import type { PaidStatus } from '../lib/types.ts'

interface PaidReportStatusProps {
  status: Exclude<PaidStatus, 'none'>
  reportId: string | null
  reportToken: string | null
  error: string | null
}

export function PaidReportStatus({ status, reportId, reportToken, error }: PaidReportStatusProps): JSX.Element {
  if (status === 'checking_out' || status === 'generating') {
    return (
      <div className="mt-6 border border-[var(--color-brand)] p-4">
        <div className="text-sm text-[var(--color-fg)] mb-1">
          Payment received — your paid report is being generated.
        </div>
        <div className="text-xs text-[var(--color-fg-muted)]">This usually takes 30-60 seconds.</div>
      </div>
    )
  }
  if (status === 'ready' && reportId && reportToken) {
    return (
      <div className="mt-6 border border-[var(--color-good)] p-4">
        <div className="text-sm text-[var(--color-fg)] mb-3">Your paid report is ready.</div>
        <a
          href={`/report/${reportId}?t=${reportToken}`}
          className="bg-[var(--color-good)] text-[var(--color-bg)] px-4 py-2 font-semibold"
        >
          View your report →
        </a>
        <div className="text-xs text-[var(--color-fg-muted)] mt-2">
          Full report rendering lands in Plan 9.
        </div>
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className="mt-6 border border-[var(--color-warn)] p-4">
        <div className="text-sm text-[var(--color-fg)] mb-1">
          Something went wrong generating your report.
        </div>
        <div className="text-xs text-[var(--color-fg-muted)]">
          {error ?? 'We\'ve been notified and will refund your payment within 24h.'}
        </div>
      </div>
    )
  }
  return <></>
}
```

- [ ] **Step 3: Write `CheckoutCanceledToast.tsx`**

```tsx
import React from 'react'
import { Toast } from './Toast.tsx'

interface CheckoutCanceledToastProps {
  onDismiss: () => void
}

export function CheckoutCanceledToast({ onDismiss }: CheckoutCanceledToastProps): JSX.Element {
  return <Toast message="Checkout canceled — no charge." onDismiss={onDismiss} />
}
```

- [ ] **Step 4: Write component tests**

`tests/unit/web/components/BuyReportButton.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuyReportButton } from '../../../../src/web/components/BuyReportButton.tsx'
import * as api from '../../../../src/web/lib/api.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('BuyReportButton', () => {
  it('clicking redirects on success', async () => {
    vi.spyOn(api, 'postBillingCheckout').mockResolvedValue({ ok: true, url: 'https://stripe.test/cs_1' })
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock, href: '' })
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    await user.click(screen.getByRole('button', { name: /full report/i }))
    expect(assignMock).toHaveBeenCalledWith('https://stripe.test/cs_1')
  })

  it('calls onAlreadyPaid on 409 already_paid', async () => {
    vi.spyOn(api, 'postBillingCheckout').mockResolvedValue({ ok: false, kind: 'already_paid', reportId: 'r-1' })
    const onAlreadyPaid = vi.fn()
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={onAlreadyPaid} />)
    await user.click(screen.getByRole('button', { name: /full report/i }))
    expect(onAlreadyPaid).toHaveBeenCalledWith('r-1')
  })

  it('shows grade_not_done error', async () => {
    vi.spyOn(api, 'postBillingCheckout').mockResolvedValue({ ok: false, kind: 'grade_not_done' })
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    await user.click(screen.getByRole('button', { name: /full report/i }))
    expect(await screen.findByText(/not done yet/i)).toBeInTheDocument()
  })
})
```

`tests/unit/web/components/PaidReportStatus.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PaidReportStatus } from '../../../../src/web/components/PaidReportStatus.tsx'

afterEach(() => cleanup())

describe('PaidReportStatus', () => {
  it('generating state shows banner + time hint', () => {
    render(<PaidReportStatus status="generating" reportId={null} reportToken={null} error={null} />)
    expect(screen.getByText(/being generated/i)).toBeInTheDocument()
    expect(screen.getByText(/30-60 seconds/i)).toBeInTheDocument()
  })

  it('ready state shows link with token', () => {
    render(<PaidReportStatus status="ready" reportId="r-1" reportToken="abc" error={null} />)
    const link = screen.getByRole('link', { name: /view your report/i })
    expect(link).toHaveAttribute('href', '/report/r-1?t=abc')
  })

  it('failed state shows error banner', () => {
    render(<PaidReportStatus status="failed" reportId={null} reportToken={null} error="boom" />)
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    expect(screen.getByText(/boom/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 5: Run — expect PASS**

`pnpm test -- tests/unit/web/components/BuyReportButton.test.tsx tests/unit/web/components/PaidReportStatus.test.tsx`

- [ ] **Step 6: Commit**

```bash
git add src/web/components/BuyReportButton.tsx src/web/components/PaidReportStatus.tsx src/web/components/CheckoutCanceledToast.tsx \
        tests/unit/web/components/BuyReportButton.test.tsx tests/unit/web/components/PaidReportStatus.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): add BuyReportButton + PaidReportStatus + CheckoutCanceledToast"
```

---

## Task 17: Frontend — wire LiveGradePage state machine

**Files:**
- Modify: `src/web/pages/LiveGradePage.tsx`
- Modify: `tests/unit/web/pages/LiveGradePage.test.tsx`
- Modify: `vite.config.ts` — add `/billing` to the dev proxy

- [ ] **Step 1: Extend `vite.config.ts` proxy**

```ts
proxy: {
  '/grades': { target: 'http://localhost:7777', changeOrigin: true },
  '/healthz': { target: 'http://localhost:7777', changeOrigin: true },
  '/auth': { target: 'http://localhost:7777', changeOrigin: true },
  '/billing': { target: 'http://localhost:7777', changeOrigin: true },
},
```

- [ ] **Step 2: Update `LiveGradePage.tsx`**

Replace the existing page with a version that composes the new components, reads URL params, and renders the right state:

```tsx
import React, { useEffect, useState } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { useGradeEvents } from '../hooks/useGradeEvents.ts'
import { StatusBar } from '../components/StatusBar.tsx'
import { CategoryTile } from '../components/CategoryTile.tsx'
import { ProbeLogRow } from '../components/ProbeLogRow.tsx'
import { GradeLetter } from '../components/GradeLetter.tsx'
import { BuyReportButton } from '../components/BuyReportButton.tsx'
import { PaidReportStatus } from '../components/PaidReportStatus.tsx'
import { CheckoutCanceledToast } from '../components/CheckoutCanceledToast.tsx'
import { CATEGORY_ORDER, CATEGORY_WEIGHTS, type PaidStatus } from '../lib/types.ts'

export function LiveGradePage(): JSX.Element {
  const { id } = useParams<{ id: string }>()
  const [params, setParams] = useSearchParams()
  const [canceledToast, setCanceledToast] = useState<boolean>(params.get('checkout') === 'canceled')
  const [checkoutComplete, setCheckoutComplete] = useState<boolean>(params.get('checkout') === 'complete')

  useEffect(() => {
    if (params.get('checkout') !== null) {
      const next = new URLSearchParams(params)
      next.delete('checkout')
      setParams(next, { replace: true })
    }
  }, [])

  if (id === undefined) return <div className="p-8 text-[var(--color-warn)]">invalid grade id</div>
  const { state } = useGradeEvents(id)

  // Derive the effective paid status: URL-based "checking_out" overrides reducer's "none".
  const effectivePaidStatus: PaidStatus =
    state.paidStatus !== 'none' ? state.paidStatus :
    checkoutComplete ? 'checking_out' : 'none'

  if (state.phase === 'failed') {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">grade failed</div>
        <h2 className="text-xl text-[var(--color-warn)] mt-2 mb-4">{state.error ?? 'unknown error'}</h2>
        <Link to="/" className="text-[var(--color-brand)] underline">try another URL →</Link>
      </div>
    )
  }

  const sortedProbes = [...state.probes.values()].sort((a, b) => a.startedAt - b.startedAt)
  const isFreeTierDone = state.phase === 'done' && effectivePaidStatus === 'none'

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">live grade</div>

      {state.phase === 'done' && state.letter !== null && state.overall !== null ? (
        <div className="mt-4 mb-6">
          <GradeLetter letter={state.letter} overall={state.overall} />
        </div>
      ) : (
        <div className="mt-2 mb-6">
          <StatusBar phase={state.phase} scraped={state.scraped} />
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-8">
        {CATEGORY_ORDER.map((cat) => (
          <CategoryTile
            key={cat}
            category={cat}
            weight={CATEGORY_WEIGHTS[cat]}
            score={state.categoryScores[cat]}
            phase={state.phase}
          />
        ))}
      </div>

      {isFreeTierDone && (
        <BuyReportButton
          gradeId={id}
          onAlreadyPaid={() => { /* reducer's next event will transition us */ }}
        />
      )}

      {effectivePaidStatus !== 'none' && (
        <PaidReportStatus
          status={effectivePaidStatus as Exclude<PaidStatus, 'none'>}
          reportId={state.reportId}
          reportToken={state.reportToken}
          error={state.error}
        />
      )}

      <div className="border-t border-[var(--color-line)] pt-4 mt-6">
        <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase mb-2">probes</div>
        <div className="flex flex-col">
          {sortedProbes.map((probe) => (
            <ProbeLogRow key={probe.key} probe={probe} />
          ))}
        </div>
      </div>

      {canceledToast && <CheckoutCanceledToast onDismiss={() => setCanceledToast(false)} />}
    </div>
  )
}
```

- [ ] **Step 3: Write 4 new LiveGradePage tests**

Append to `tests/unit/web/pages/LiveGradePage.test.tsx`:

```tsx
describe('LiveGradePage — paid flow', () => {
  it('shows BuyReportButton when tier=free + status=done', async () => {
    // Mock useGradeEvents to return a done free grade
    // Assert: button with "full report" is visible
  })

  it('shows PaidReportStatus banner when ?checkout=complete is in URL', async () => {
    // Render with ?checkout=complete
    // Assert: "being generated" banner visible; URL param stripped
  })

  it('shows CheckoutCanceledToast when ?checkout=canceled', async () => {
    // Render with ?checkout=canceled
    // Assert: toast visible
  })

  it('shows "View your report" link when paidStatus=ready', async () => {
    // Mock useGradeEvents to return paidStatus='ready' + reportId + token
    // Assert: <a href=/report/{id}?t={token}> visible
  })
})
```

Flesh out each test body using the existing LiveGradePage test patterns (mock useGradeEvents via `vi.mock`, mount inside MemoryRouter).

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/web/pages/LiveGradePage.test.tsx`

- [ ] **Step 5: Full validation**

```
pnpm test
pnpm test:integration
pnpm typecheck
pnpm build
```

All must pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/pages/LiveGradePage.tsx tests/unit/web/pages/LiveGradePage.test.tsx vite.config.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): LiveGradePage paid-flow state machine + vite proxy for /billing"
```

---

## Task 18: Docs — checklist + master-spec anchor + README

**Files:**
- Modify: `docs/production-checklist.md`
- Modify: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` (anchor under §7.3)
- Modify: `README.md` — roadmap + auth flow note about paid tier

- [ ] **Step 1: Update production-checklist**

Add to the Security section:

```markdown
- [ ] **Rate-limit on /billing/checkout.** Plan 8 doesn't add one. A malicious cookie-holder can hit the endpoint repeatedly, spamming the `stripe_payments` table with orphan pending rows. Bounded (session tied to one owned grade), but worth a modest per-cookie bucket before public launch.
```

Add to the Reliability / ops section:

```markdown
- [ ] **Auto-refund on generate-report failure.** Currently: grade marked with error flag, manual Stripe-dashboard refund. Before real traffic, add: on 3rd BullMQ retry failure, call `stripe.refunds.create({ payment_intent })`, update `stripe_payments.status='refunded'`, publish `report.refunded` event. Needs careful handling of partial work (recommendations already persisted but no `reports` row).
- [ ] **Admin dashboard for payment reconciliation.** We'll need a way to see paid-but-failed grades, trigger manual refunds, and retry failed jobs. Not MVP-blocking; without it, any issue requires DB + Stripe-dashboard back-and-forth.
```

Add to the Deploy / ops section:

```markdown
- [ ] **Real Stripe webhook registration + CLI smoke test.** Plan 10 deploy work — register prod webhook URL in the Stripe dashboard, grab the signing secret, set env vars. Run a real-mode test via Stripe CLI (`stripe trigger checkout.session.completed`). Also: create the `price_...` for the $19 GEO Report in the Stripe dashboard.
```

- [ ] **Step 2: Update master-spec anchor**

Below `### 7.3 Paid tier` in `docs/superpowers/specs/2026-04-17-geo-reporter-design.md`:

```markdown
> **Sub-spec:** See `docs/superpowers/specs/2026-04-19-geo-reporter-plan-8-stripe-paywall-design.md` for the Plan 8 design — brainstormed 2026-04-19, shipped in Plan 8.
```

- [ ] **Step 3: Update README**

Find the Roadmap section. Change Plan 8 line from "Pending" to "Done (YYYY-MM-DD)" (use today's date at merge time).

Find the "What you'll see" section on the browser flow. Update the LiveGrade bullet to mention the paid flow:

```markdown
- **LiveGrade `/g/:id`** — 6 category tiles fill in live via SSE; chronological probe log below. On `done`, a big letter grade replaces the status bar. The free scorecard is below a `Get the full report — $19` CTA that kicks off Stripe Checkout. After payment, the page watches SSE for `report.*` events and flips to a "report ready" state with a link to `/report/:id?t=<token>` (Plan 9 renders the page).
```

Update test counts at the bottom of the "What runs today" table: 375 → ~400 unit / 60 → ~65 integration (use actual counts from your final run).

- [ ] **Step 4: Full validation**

`pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm build` all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/production-checklist.md docs/superpowers/specs/2026-04-17-geo-reporter-design.md README.md
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "docs: Plan 8 wrap-up — checklist diff, master-spec anchor, README paid flow"
```

---

## Final verification

- [ ] `pnpm test` — all unit tests pass.
- [ ] `pnpm test:integration` — all integration tests pass.
- [ ] `pnpm typecheck` — no errors.
- [ ] `pnpm build` — clean.
- [ ] Smoke test locally:
  1. `pnpm dev:server`, `pnpm dev:worker`, `pnpm dev:web`.
  2. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` in `.env` (use test-mode keys).
  3. In another terminal: `stripe listen --forward-to localhost:7777/billing/webhook` (copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`).
  4. Run a free grade to completion in the browser.
  5. Click the "Get the full report — $19" button; redirected to Stripe test-mode checkout.
  6. Use card `4242 4242 4242 4242` with any future date + any CVC.
  7. Redirected back to `/g/:id?checkout=complete`; `PaidReportStatus` banner visible.
  8. ConsoleMailer terminal shows generate-report probe logs (Gemini + Perplexity).
  9. Banner transitions to "Your paid report is ready" with a "View your report →" link.
  10. Click the link: expected 404 (Plan 9 hasn't shipped).
