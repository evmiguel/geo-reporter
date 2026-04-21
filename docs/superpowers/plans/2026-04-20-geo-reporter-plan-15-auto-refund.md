# Plan 15 — Auto-refund on generate-report failure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** When the generate-report BullMQ job fails all 3 retries, auto-refund the user: Stripe refund for $19 one-offs, credit grant for credit redemptions. Emit `report.refunded` SSE, send user a refund-notice email, handle Stripe API failures gracefully with a `refund_pending` state.

**Architecture:** New `BillingClient.refund()` + `Mailer.sendRefundNotice()` interface methods. New `autoRefundFailedReport(gradeId, deps)` pure helper called from a worker-level `.on('failed', ...)` BullMQ listener. Idempotent via `stripe_payments.status` check. Reducer gets a new `'refunded'` paid status; `PaidReportStatus` renders dedicated copy.

**Tech Stack:** TypeScript 5.6+, Stripe Node SDK, Hono 4, BullMQ 5, Vitest 2 + testcontainers 10.

**Spec:** `docs/superpowers/specs/2026-04-20-geo-reporter-plan-15-auto-refund-design.md`

---

## Task 1: `BillingClient.refund()` + StripeBillingClient + FakeStripe

**Files:**
- Modify: `src/billing/types.ts`
- Modify: `src/billing/stripe-client.ts`
- Modify: `tests/unit/_helpers/fake-stripe.ts`
- Test: `tests/unit/billing/refund.test.ts` (new)

- [ ] **Step 1: Extend the interface** in `src/billing/types.ts`. Add:

```ts
export interface RefundResult {
  ok: boolean
  amountRefunded?: number
  errorMessage?: string
}
```

And add to `BillingClient`:
```ts
refund(sessionId: string): Promise<RefundResult>
```

- [ ] **Step 2: Write failing test.** `tests/unit/billing/refund.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FakeStripe } from '../_helpers/fake-stripe.ts'

describe('FakeStripe.refund', () => {
  it('returns ok:true by default + records the refund', async () => {
    const stripe = new FakeStripe()
    const session = await stripe.createCheckoutSession({
      kind: 'report', gradeId: 'g1', successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await stripe.completeSession(session.id)
    const result = await stripe.refund(session.id)
    expect(result.ok).toBe(true)
    expect(stripe.refunds).toHaveLength(1)
    expect(stripe.refunds[0]!.sessionId).toBe(session.id)
  })

  it('returns ok:false when failRefundsFor was called for this session', async () => {
    const stripe = new FakeStripe()
    const session = await stripe.createCheckoutSession({
      kind: 'report', gradeId: 'g2', successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await stripe.completeSession(session.id)
    stripe.failRefundsFor(session.id)
    const result = await stripe.refund(session.id)
    expect(result.ok).toBe(false)
    expect(result.errorMessage).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run** `pnpm test tests/unit/billing/refund.test.ts` → FAIL.

- [ ] **Step 4: Implement in FakeStripe.** Read `tests/unit/_helpers/fake-stripe.ts` first. Add:

```ts
public readonly refunds: { sessionId: string }[] = []
private readonly failRefundsSet = new Set<string>()

failRefundsFor(sessionId: string): void { this.failRefundsSet.add(sessionId) }

async refund(sessionId: string): Promise<RefundResult> {
  if (this.failRefundsSet.has(sessionId)) {
    return { ok: false, errorMessage: 'simulated refund failure' }
  }
  this.refunds.push({ sessionId })
  return { ok: true, amountRefunded: 1900 }
}
```

Make sure `RefundResult` is imported from `billing/types.ts`.

- [ ] **Step 5: Implement in `StripeBillingClient`.** In `src/billing/stripe-client.ts`, add:

```ts
async refund(sessionId: string): Promise<RefundResult> {
  try {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    })
    const pi = session.payment_intent
    const piId = typeof pi === 'string' ? pi : pi?.id
    if (!piId) {
      return { ok: false, errorMessage: 'session has no payment_intent (probably not paid)' }
    }
    const refund = await this.stripe.refunds.create({ payment_intent: piId })
    return { ok: true, amountRefunded: refund.amount }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, errorMessage: `stripe refund: ${message}` }
  }
}
```

- [ ] **Step 6: Run tests + typecheck.**

```
pnpm test tests/unit/billing
pnpm typecheck
```

Typecheck will complain that any existing fake billing clients don't implement `refund`. Add a stub to each (throw "not implemented" or return `{ ok: true }` depending on context). Read the files, fix as needed.

- [ ] **Step 7: Commit.**

```bash
git add src/billing/ tests/unit/_helpers/fake-stripe.ts tests/unit/billing/refund.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): BillingClient.refund() for Stripe refund orchestration"
```

---

## Task 2: `Mailer.sendRefundNotice()` + implementations

**Files:**
- Modify: `src/mail/types.ts`
- Modify: `src/mail/console-mailer.ts`
- Modify: `src/mail/resend-mailer.ts`
- Modify: `tests/unit/_helpers/fake-mailer.ts`
- Test: `tests/unit/mail/refund-notice.test.ts` (new)

- [ ] **Step 1: Extend interface** in `src/mail/types.ts`:

```ts
export interface RefundNoticeMessage {
  to: string
  domain: string
  kind: 'credit' | 'stripe'
}

export interface Mailer {
  sendMagicLink(msg: MagicLinkMessage): Promise<void>
  sendRefundNotice(msg: RefundNoticeMessage): Promise<void>
}
```

- [ ] **Step 2: Write failing test.** `tests/unit/mail/refund-notice.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { ConsoleMailer } from '../../../src/mail/console-mailer.ts'

describe('ConsoleMailer.sendRefundNotice', () => {
  it('logs the refund notice to stdout', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mailer = new ConsoleMailer()
    await mailer.sendRefundNotice({ to: 'u@x', domain: 'stripe.com', kind: 'credit' })
    expect(spy).toHaveBeenCalled()
    const firstArg = spy.mock.calls[0]!.join(' ')
    expect(firstArg).toContain('refund-notice')
    expect(firstArg).toContain('u@x')
    expect(firstArg).toContain('stripe.com')
    spy.mockRestore()
  })
})
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement in `ConsoleMailer`** (read file first):

```ts
async sendRefundNotice(msg: RefundNoticeMessage): Promise<void> {
  console.log(JSON.stringify({ msg: 'refund-notice', to: msg.to, domain: msg.domain, kind: msg.kind }))
}
```

- [ ] **Step 5: Implement in `ResendMailer`.** Mirror the existing `sendMagicLink` call shape. Subject: `"Your GEO Report refund"`. Body:

```
Your GEO Report for {domain} couldn't be generated after three tries.

{kind === 'credit'
  ? "Your credit is back on your account — try again whenever you're ready."
  : "Your $19 payment has been refunded to your card. It takes 5–10 business days to appear."}

Sorry about that. If you have questions, reply to this email.
```

Keep HTML + text versions consistent with existing style in `resend-mailer.ts`.

- [ ] **Step 6: Update `FakeMailer`** in `tests/unit/_helpers/fake-mailer.ts`. Add:

```ts
public readonly refundNotices: RefundNoticeMessage[] = []
async sendRefundNotice(msg: RefundNoticeMessage): Promise<void> {
  this.refundNotices.push(msg)
}
```

- [ ] **Step 7: Run tests + typecheck.** Typecheck will flag any other places that implement `Mailer` (search codebase, likely only `ConsoleMailer` / `ResendMailer` / `FakeMailer`).

- [ ] **Step 8: Commit.**

```bash
git add src/mail/ tests/unit/_helpers/fake-mailer.ts tests/unit/mail/refund-notice.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(mail): Mailer.sendRefundNotice for auto-refund emails"
```

---

## Task 3: `GradeStore.incrementCredits()`

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/postgres.ts`
- Modify: `tests/unit/_helpers/fake-store.ts`
- Test: `tests/integration/store-increment-credits.test.ts` (new)

- [ ] **Step 1: Add to interface** in `src/store/types.ts`:

```ts
incrementCredits(userId: string, delta: number): Promise<number>
```

(Returns new balance.)

- [ ] **Step 2: Write failing integration test.** `tests/integration/store-increment-credits.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.incrementCredits', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('increments a user\'s credits and returns the new balance', async () => {
    const user = await store.upsertUser('plus@example.com')
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_seed', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_seed', user.id, 10, 2900, 'usd')
    expect(await store.getCredits(user.id)).toBe(10)

    const after = await store.incrementCredits(user.id, 1)
    expect(after).toBe(11)
    expect(await store.getCredits(user.id)).toBe(11)
  })

  it('handles negative delta (decrement; used nowhere today but safe)', async () => {
    const user = await store.upsertUser('minus@example.com')
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_minus', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_minus', user.id, 5, 2900, 'usd')
    const after = await store.incrementCredits(user.id, -2)
    expect(after).toBe(3)
  })

  it('throws on missing user', async () => {
    await expect(store.incrementCredits('00000000-0000-0000-0000-000000000000', 1))
      .rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement in `PostgresStore`.** Near other credit methods:

```ts
async incrementCredits(userId: string, delta: number): Promise<number> {
  const [row] = await this.db
    .update(schema.users)
    .set({ credits: sql`${schema.users.credits} + ${delta}` })
    .where(eq(schema.users.id, userId))
    .returning({ credits: schema.users.credits })
  if (!row) throw new Error(`incrementCredits: user ${userId} not found`)
  return row.credits
}
```

- [ ] **Step 5: Implement in fake-store:**

```ts
async incrementCredits(userId: string, delta: number): Promise<number> {
  const user = [...this.usersMap.values()].find((u) => u.id === userId)
  if (!user) throw new Error(`incrementCredits: user ${userId} not found`)
  user.credits = (user.credits ?? 0) + delta
  return user.credits
}
```

(Adapt map name if different.)

- [ ] **Step 6: Run tests.**

```
pnpm test:integration tests/integration/store-increment-credits.test.ts
pnpm test && pnpm typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts tests/integration/store-increment-credits.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): incrementCredits(userId, delta) for refund credit grants"
```

---

## Task 4: `report.refunded` SSE event + reducer + types

**Files:**
- Modify: `src/queue/events.ts` (server event type + subscription close list)
- Modify: `src/web/lib/types.ts` (client event + PaidStatus + GradeState)
- Modify: `src/web/lib/grade-reducer.ts`
- Test: `tests/unit/web/grade-reducer.test.ts` (add case)

- [ ] **Step 1: Extend server event union** in `src/queue/events.ts`. Add to `GradeEvent`:

```ts
| { type: 'report.refunded'; refundKind: 'credit' | 'stripe'; reason?: string }
```

Add `'report.refunded'` to the subscription auto-close list (around line 94-98 where `report.done` / `report.failed` already trigger finish).

- [ ] **Step 2: Mirror on client** in `src/web/lib/types.ts`. Add same variant to the `GradeEvent` union.

- [ ] **Step 3: Extend `PaidStatus`** in `src/web/lib/types.ts`:

```ts
export type PaidStatus = 'none' | 'checking_out' | 'generating' | 'ready' | 'failed' | 'refunded'
```

- [ ] **Step 4: Add `paidRefundKind` to `GradeState`**:

```ts
paidRefundKind: 'credit' | 'stripe' | null
```

Also in `initialGradeState`: `paidRefundKind: null`.

- [ ] **Step 5: Write failing reducer test.** Add to `tests/unit/web/grade-reducer.test.ts`:

```ts
it('reduces report.refunded → paidStatus=refunded + paidRefundKind captured', () => {
  const state = { ...initialGradeState(), paidStatus: 'generating' as const }
  const next = reduceGradeEvents(
    state,
    { type: 'report.refunded', refundKind: 'credit' },
    0,
  )
  expect(next.paidStatus).toBe('refunded')
  expect(next.paidRefundKind).toBe('credit')
  expect(next.reportPhase).toBeNull()
})
```

- [ ] **Step 6: Run** → FAIL.

- [ ] **Step 7: Update reducer.** In `src/web/lib/grade-reducer.ts`, add case:

```ts
case 'report.refunded':
  return {
    ...state,
    paidStatus: 'refunded',
    paidRefundKind: event.refundKind,
    reportPhase: null,
  }
```

- [ ] **Step 8: Run tests + typecheck.** Typecheck will flag test files that construct `GradeState` literals without `paidRefundKind`. Add `paidRefundKind: null` to each (grep for `reportPhase: null` to find them).

- [ ] **Step 9: Commit.**

```bash
git add src/queue/events.ts src/web/lib/ tests/unit/web/grade-reducer.test.ts tests/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(events): report.refunded + paidRefundKind reducer state"
```

---

## Task 5: `autoRefundFailedReport` pure helper

**Files:**
- Create: `src/queue/workers/generate-report/auto-refund.ts`
- Test: `tests/unit/queue/workers/generate-report/auto-refund.test.ts` (new)

- [ ] **Step 1: Write failing tests.** `tests/unit/queue/workers/generate-report/auto-refund.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'
import { FakeStripe } from '../../../_helpers/fake-stripe.ts'
import { FakeMailer } from '../../../_helpers/fake-mailer.ts'
import { makeStubRedis } from '../../../_helpers/stub-redis.ts'
import { autoRefundFailedReport } from '../../../../../src/queue/workers/generate-report/auto-refund.ts'

describe('autoRefundFailedReport', () => {
  async function setup() {
    const store = makeFakeStore()
    const billing = new FakeStripe()
    const mailer = new FakeMailer()
    const redis = makeStubRedis()
    return { store, billing, mailer, redis }
  }

  it('skips when no paid stripe_payments for the grade', async () => {
    const { store, billing, mailer, redis } = await setup()
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie: 'c', userId: null, status: 'failed',
    })
    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('skipped_not_paid')
    expect(billing.refunds).toHaveLength(0)
  })

  it('skips when payment is already refunded (idempotent)', async () => {
    const { store, billing, mailer, redis } = await setup()
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: 'c', userId: null, status: 'failed',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_done', amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus('cs_done', { status: 'refunded' })
    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('skipped_not_paid')
    expect(billing.refunds).toHaveLength(0)
  })

  it('issues Stripe refund for kind=report, marks status=refunded, emits SSE, emails user', async () => {
    const { store, billing, mailer, redis } = await setup()
    const user = await store.upsertUser('refund@example.com')
    await store.upsertCookie('c-refund', user.id)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie: 'c-refund', userId: user.id, status: 'failed',
    })
    const session = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus(session.id, { status: 'paid' })

    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('stripe_refunded')
    expect(billing.refunds).toHaveLength(1)

    const pay = await store.getStripePaymentBySessionId(session.id)
    expect(pay!.status).toBe('refunded')
    expect(mailer.refundNotices).toHaveLength(1)
    expect(mailer.refundNotices[0]!.kind).toBe('stripe')
  })

  it('marks status=refund_pending when Stripe refund fails', async () => {
    const { store, billing, mailer, redis } = await setup()
    const user = await store.upsertUser('pending@example.com')
    await store.upsertCookie('c-pending', user.id)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie: 'c-pending', userId: user.id, status: 'failed',
    })
    const session = await billing.createCheckoutSession({
      kind: 'report', gradeId: grade.id, successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: session.id, amountCents: 1900, currency: 'usd', kind: 'report',
    })
    await store.updateStripePaymentStatus(session.id, { status: 'paid' })
    billing.failRefundsFor(session.id)

    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('refund_pending')

    const pay = await store.getStripePaymentBySessionId(session.id)
    expect(pay!.status).toBe('refund_pending')
  })

  it('grants credit for kind=credits, increments user.credits, emits SSE + email', async () => {
    const { store, billing, mailer, redis } = await setup()
    const user = await store.upsertUser('credit-refund@example.com')
    await store.upsertCookie('c-credit-refund', user.id)
    // seed 5 credits
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_pack', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_pack', user.id, 5, 2900, 'usd')
    await store.redeemCredit(user.id)  // decrement → 4
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie: 'c-credit-refund', userId: user.id, status: 'failed',
    })
    // audit row from redeem
    const auditSessionId = `cs_credit_${grade.id}`
    await store.createStripePayment({
      gradeId: grade.id, sessionId: auditSessionId, amountCents: 0, currency: 'usd',
      kind: 'credits', userId: user.id,
    })
    await store.updateStripePaymentStatus(auditSessionId, { status: 'paid' })

    const result = await autoRefundFailedReport(grade.id, { store, billing, mailer, redis })
    expect(result.kind).toBe('credit_granted')
    expect(await store.getCredits(user.id)).toBe(5)   // 4 + 1

    const pay = await store.getStripePaymentBySessionId(auditSessionId)
    expect(pay!.status).toBe('refunded')
    expect(billing.refunds).toHaveLength(0)  // no Stripe call for credits
    expect(mailer.refundNotices).toHaveLength(1)
    expect(mailer.refundNotices[0]!.kind).toBe('credit')
  })
})
```

NOTE: `redeemCredit` and the audit-row sessionId format may differ from what's written here. Read `src/server/routes/billing.ts` + `src/store/postgres.ts` to see the real shape and adjust test fixtures. The assertions on refund behavior remain the same.

- [ ] **Step 2: Run** → expect FAIL (module doesn't exist).

- [ ] **Step 3: Implement `auto-refund.ts`:**

```ts
import type Redis from 'ioredis'
import type { GradeStore } from '../../../store/types.ts'
import type { BillingClient } from '../../../billing/types.ts'
import type { Mailer } from '../../../mail/types.ts'
import { publishGradeEvent } from '../../events.ts'

export interface AutoRefundDeps {
  store: GradeStore
  billing: BillingClient
  mailer: Mailer
  redis: Redis
}

export interface AutoRefundResult {
  kind: 'skipped_not_paid' | 'stripe_refunded' | 'credit_granted' | 'refund_pending'
  errorMessage?: string
}

export async function autoRefundFailedReport(
  gradeId: string,
  deps: AutoRefundDeps,
): Promise<AutoRefundResult> {
  const payments = await deps.store.listStripePaymentsByGrade(gradeId)
  const paid = payments.find((p) => p.status === 'paid')
  if (!paid) return { kind: 'skipped_not_paid' }

  const grade = await deps.store.getGrade(gradeId)
  if (!grade) return { kind: 'skipped_not_paid' }

  // Fetch the user email for the refund notice. grade.userId is set on
  // paid grades via the billing route; if null we skip the email but
  // still refund.
  let userEmail: string | null = null
  if (grade.userId) {
    const cookieRow = await deps.store.getCookieWithUserAndCredits(grade.cookie ?? '')
    userEmail = cookieRow?.email ?? null
  }

  if (paid.kind === 'report') {
    const refund = await deps.billing.refund(paid.sessionId)
    if (!refund.ok) {
      await deps.store.updateStripePaymentStatus(paid.sessionId, { status: 'refund_pending' })
      console.error('[auto-refund-failed]', gradeId, paid.sessionId, refund.errorMessage)
      return { kind: 'refund_pending', errorMessage: refund.errorMessage }
    }
    await deps.store.updateStripePaymentStatus(paid.sessionId, { status: 'refunded' })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'report.refunded', refundKind: 'stripe',
    })
    if (userEmail) {
      try {
        await deps.mailer.sendRefundNotice({ to: userEmail, domain: grade.domain, kind: 'stripe' })
      } catch (err) {
        console.error('[auto-refund-email-failed]', gradeId, err)
      }
    }
    return { kind: 'stripe_refunded' }
  }

  // kind === 'credits' — audit row from /billing/redeem-credit
  if (paid.kind === 'credits' && grade.userId) {
    try {
      await deps.store.incrementCredits(grade.userId, 1)
    } catch (err) {
      console.error('[auto-refund-credit-failed]', gradeId, err)
      await deps.store.updateStripePaymentStatus(paid.sessionId, { status: 'refund_pending' })
      return { kind: 'refund_pending', errorMessage: String(err) }
    }
    await deps.store.updateStripePaymentStatus(paid.sessionId, { status: 'refunded' })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'report.refunded', refundKind: 'credit',
    })
    if (userEmail) {
      try {
        await deps.mailer.sendRefundNotice({ to: userEmail, domain: grade.domain, kind: 'credit' })
      } catch (err) {
        console.error('[auto-refund-email-failed]', gradeId, err)
      }
    }
    return { kind: 'credit_granted' }
  }

  return { kind: 'skipped_not_paid' }
}
```

- [ ] **Step 4: Run tests + typecheck.**

- [ ] **Step 5: Commit.**

```bash
git add src/queue/workers/generate-report/auto-refund.ts tests/unit/queue/workers/generate-report/auto-refund.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(refund): autoRefundFailedReport — idempotent Stripe + credit flow"
```

---

## Task 6: Wire `.on('failed')` listener into worker + deps

**Files:**
- Modify: `src/queue/workers/generate-report/index.ts` (or wherever the Worker is constructed)
- Modify: `src/queue/workers/generate-report/deps.ts` (or equivalent — the deps passed in to the worker)
- Modify: worker entrypoint (`src/worker/worker.ts` or similar) — wire billing + mailer
- Test: `tests/integration/generate-report-auto-refund.test.ts` (new, uses testcontainers)

- [ ] **Step 1: Find the worker construction site.** Run `grep -rn "new Worker" src/queue/` and follow. The file registers the BullMQ processor — probably `src/queue/workers/generate-report/index.ts`.

- [ ] **Step 2: Extend the deps** to include `billing: BillingClient` and `mailer: Mailer`. Read the file to see the current shape of deps; add the two fields and thread them through.

- [ ] **Step 3: Add the failure listener.** After the `new Worker(...)` call:

```ts
worker.on('failed', (job, err) => {
  if (!job) return
  const attempts = job.opts.attempts ?? 1
  if (job.attemptsMade < attempts) return  // will retry; not final
  void autoRefundFailedReport(job.data.gradeId, {
    store: deps.store,
    billing: deps.billing,
    mailer: deps.mailer,
    redis: deps.redis,
  }).catch((fatal) => {
    console.error('[auto-refund-boundary]', job.data.gradeId, fatal)
  })
})
```

Import `autoRefundFailedReport` from `./auto-refund.ts`.

- [ ] **Step 4: Wire billing + mailer in the worker entrypoint.** Open `src/worker/worker.ts` (or wherever the worker process boots). It already has `store` + `redis`; needs `billing` + `mailer` the same way the HTTP server builds them. Copy-adapt the construction from `src/server/server.ts`:

```ts
// somewhere near where the worker's other deps are built
const billing = env.STRIPE_SECRET_KEY ? new StripeBillingClient(...) : null
const mailer = env.RESEND_API_KEY ? new ResendMailer(...) : new ConsoleMailer()
```

If billing is null (Stripe not configured in dev), auto-refund effectively skips any stripe-refund path. Log a startup warning.

- [ ] **Step 5: Write integration test.** `tests/integration/generate-report-auto-refund.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// mirror existing generate-report integration test setup
// Seed: user + grade + paid stripe_payment
// Enqueue a generate-report job with a prover that always throws
// Wait for the job to fail all 3 attempts
// Assert: stripe_payments.status === 'refunded', audit-refund event received via SSE
```

The exact shape depends on how existing integration tests of the worker look. If there isn't one, this is a bigger undertaking — read `tests/integration/` for a similar pattern and mirror it. If setting up a BullMQ testcontainer path is too heavy, you can also unit-test the listener by mocking `job` and `worker.on`.

ALTERNATIVE: if integration test is hard, expose the listener as a standalone function `handleFailedJob(job, deps)` and unit-test that instead of the whole worker. That's fine for coverage.

- [ ] **Step 6: Run tests + typecheck.**

- [ ] **Step 7: Commit.**

```bash
git add src/queue/workers/generate-report/ src/worker/ tests/integration/generate-report-auto-refund.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(worker): on('failed') listener triggers auto-refund after retries exhausted"
```

---

## Task 7: Frontend — PaidReportStatus refunded branch

**Files:**
- Modify: `src/web/components/PaidReportStatus.tsx`
- Modify: `src/web/pages/LiveGradePage.tsx` — pass `paidRefundKind` through
- Test: `tests/unit/web/components/PaidReportStatus.test.tsx` (add case)

- [ ] **Step 1: Update props** on `PaidReportStatus`:

```ts
interface PaidReportStatusProps {
  status: 'ready' | 'failed' | 'refunded'
  reportId: string | null
  reportToken: string | null
  error: string | null
  refundKind: 'credit' | 'stripe' | null
}
```

- [ ] **Step 2: Add refunded branch** (read file first for the existing render style):

```tsx
if (status === 'refunded') {
  return (
    <div className="mt-6 border border-[var(--color-good)] p-4">
      <div className="text-sm text-[var(--color-fg)] mb-1">
        Refunded — the report couldn't be generated after three tries.
      </div>
      <div className="text-xs text-[var(--color-fg-muted)]">
        {refundKind === 'credit'
          ? 'Your credit is back on your account. Try another URL whenever you\'re ready.'
          : 'Your $19 payment has been refunded to your card (takes 5–10 business days).'}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Update LiveGradePage** — gate the refunded branch, pass `paidRefundKind`:

```tsx
{(effectivePaidStatus === 'ready' || effectivePaidStatus === 'failed' || effectivePaidStatus === 'refunded') && (
  <PaidReportStatus
    status={effectivePaidStatus}
    reportId={state.reportId}
    reportToken={state.reportToken}
    error={state.error}
    refundKind={state.paidRefundKind}
  />
)}
```

Also update the ReportProgress mount condition to exclude `'refunded'` — it's a terminal state, no progress to show.

- [ ] **Step 4: Write failing test.** Add to `tests/unit/web/components/PaidReportStatus.test.tsx`:

```tsx
it('renders credit refund copy when status=refunded + refundKind=credit', () => {
  render(<PaidReportStatus status="refunded" reportId={null} reportToken={null} error={null} refundKind="credit" />)
  expect(screen.getByText(/refunded/i)).toBeInTheDocument()
  expect(screen.getByText(/credit is back/i)).toBeInTheDocument()
})

it('renders stripe refund copy when status=refunded + refundKind=stripe', () => {
  render(<PaidReportStatus status="refunded" reportId={null} reportToken={null} error={null} refundKind="stripe" />)
  expect(screen.getByText(/\$19 payment has been refunded/i)).toBeInTheDocument()
})
```

- [ ] **Step 5: Run tests + typecheck.**

- [ ] **Step 6: Commit.**

```bash
git add src/web/components/PaidReportStatus.tsx src/web/pages/LiveGradePage.tsx tests/unit/web/components/PaidReportStatus.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): PaidReportStatus renders dedicated refund copy"
```

---

## Task 8: Retrofit script

**Files:**
- Create: `scripts/refund-failed-reports.ts`

- [ ] **Step 1: Implement the script.** Read an existing `scripts/*.ts` for the connection-setup pattern; then:

```ts
// Connects via DATABASE_URL + STRIPE_SECRET_KEY, scans for:
//   grades.status = 'failed' AND stripe_payments.status = 'paid' AND no reports row
// Runs autoRefundFailedReport on each.
// --dry-run prints what it would do without mutating anything.

import { loadEnv } from '../src/config/env.ts'
import { PostgresStore } from '../src/store/postgres.ts'
import { StripeBillingClient } from '../src/billing/stripe-client.ts'
import { ConsoleMailer } from '../src/mail/console-mailer.ts'
import { createDb } from '../src/db/index.ts'   // or wherever createDb lives
import Redis from 'ioredis'
import { autoRefundFailedReport } from '../src/queue/workers/generate-report/auto-refund.ts'

async function main() {
  const env = loadEnv()
  const dryRun = process.argv.includes('--dry-run')
  const db = createDb(env.DATABASE_URL)
  const store = new PostgresStore(db)
  const redis = new Redis(env.REDIS_URL)
  const billing = new StripeBillingClient({ apiKey: env.STRIPE_SECRET_KEY })
  const mailer = new ConsoleMailer()

  // Find candidates
  const candidates = await db.execute(sql`
    SELECT DISTINCT g.id
    FROM grades g
    JOIN stripe_payments p ON p.grade_id = g.id
    LEFT JOIN reports r ON r.grade_id = g.id
    WHERE g.status = 'failed'
      AND p.status = 'paid'
      AND r.id IS NULL
  `)

  console.log(`Found ${candidates.length} candidate(s)${dryRun ? ' (dry-run)' : ''}`)
  for (const row of candidates) {
    if (dryRun) { console.log('would refund grade', row.id); continue }
    const result = await autoRefundFailedReport(row.id as string, { store, billing, mailer, redis })
    console.log('refunded', row.id, result.kind)
  }
  await redis.quit()
  process.exit(0)
}
main().catch((err) => { console.error(err); process.exit(1) })
```

Adjust imports to match the actual project structure (the `createDb` pattern, the sql import).

- [ ] **Step 2: Smoke test locally.** Point at a test DB; seed a failed grade with paid payment; run `pnpm tsx scripts/refund-failed-reports.ts --dry-run` → should print 1 candidate.

- [ ] **Step 3: Commit.**

```bash
git add scripts/refund-failed-reports.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "script: refund-failed-reports retrofit for grades stuck in paid+failed state"
```

---

## Self-review checklist

- P15-1 Stripe refund for $19 → Tasks 1 + 5 ✓
- P15-2 credit grant for redemptions → Tasks 3 + 5 ✓
- P15-3 `.on('failed')` listener with attempts check → Task 6 ✓
- P15-4 idempotency via status check → Task 5 (step 3, `find(p => p.status === 'paid')`) ✓
- P15-5 refund_pending fallback → Task 5 ✓
- P15-6 user email via Resend → Tasks 2 + 5 ✓
- P15-7 SSE event → Task 4 ✓
- P15-8 reducer `refunded` state → Task 4 ✓
- P15-9 retrofit script → Task 8 ✓

**Type consistency:**
- `RefundResult` declared Task 1, consumed Task 5
- `RefundNoticeMessage` declared Task 2, consumed Task 5
- `incrementCredits(userId, delta)` declared Task 3, consumed Task 5
- `report.refunded` event + `PaidStatus`/`paidRefundKind` declared Task 4, consumed Tasks 5, 7
- `autoRefundFailedReport(gradeId, deps)` declared Task 5, consumed Tasks 6, 8
