# Plan 15 — Auto-refund on generate-report failure

**Date:** 2026-04-20
**Status:** Design
**Author:** Claude + Erika

## 1. Problem

A user pays $19 (or redeems a credit), the `generate-report` worker retries 3× and fails. Today: `stripe_payments.status` stays `'paid'`, the user sees an error page, the operator has to manually refund via Stripe dashboard and re-grant credits via SQL. Unacceptable for marketed launch.

## 2. Decisions (locked)

| ID | Decision |
|----|----------|
| P15-1 | **$19 one-offs refund via Stripe** — `stripe.refunds.create({ payment_intent })`. |
| P15-2 | **Credit redemptions refund by incrementing `users.credits += 1`** — no Stripe call, no partial refund on the credit pack. |
| P15-3 | **Trigger: BullMQ `.on('failed')` listener, filtered to `attemptsMade === opts.attempts`.** Only fires after final retry. |
| P15-4 | **Idempotency by `stripe_payments.status`.** Read-modify-write: if status !== 'paid', skip. Prevents double-refund if the listener re-fires. |
| P15-5 | **Stripe refund failure path:** mark `status='refund_pending'`, log loudly with `[auto-refund-failed]` tag, email the operator via `MAIL_FROM`. Admin can see `refund_pending` and resolve manually. |
| P15-6 | **User notification via Resend.** New `Mailer.sendRefundNotice(args)` method. Template explains what happened + the refund form ($credit or $stripe). ConsoleMailer logs in dev. |
| P15-7 | **SSE event: `report.refunded { refundKind: 'credit' \| 'stripe', reason?: string }`.** Fires after DB writes succeed. Subscription closes on this event (same as `report.done`/`failed`). |
| P15-8 | **Reducer: `paidStatus='refunded'`** as a new terminal state (distinct from `'failed'`). UI shows refund-specific copy. |
| P15-9 | **Retrofit: one-shot script `scripts/refund-failed-reports.ts`.** Scans for `grade.status='failed'` + `stripe_payments.status='paid'` where the grade predates this plan. Idempotent (re-running does nothing extra). |

## 3. Architecture

### 3.1 `BillingClient.refund(sessionId): Promise<RefundResult>`

New method on the billing interface.

```ts
export interface RefundResult {
  ok: boolean
  amountRefunded?: number   // cents, from Stripe
  errorMessage?: string
}

export interface BillingClient {
  // ... existing
  refund(sessionId: string): Promise<RefundResult>
}
```

`StripeBillingClient`: looks up the session via `stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] })`, extracts `payment_intent`, calls `stripe.refunds.create({ payment_intent: pi.id })`. Returns `ok: true` on success; catches and returns `ok: false, errorMessage` otherwise.

`FakeStripe` (tests): in-memory `refunds` map; by default `refund()` resolves ok. A `FakeStripe.failRefundsFor(sessionId)` helper lets tests simulate Stripe failures.

### 3.2 `autoRefundFailedReport(gradeId, deps)` — pure helper

New file `src/queue/workers/generate-report/auto-refund.ts`. Orchestrates the refund flow. Deps: `{ store, billing, mailer, redis }`.

```ts
interface AutoRefundResult {
  kind: 'skipped_not_paid' | 'stripe_refunded' | 'credit_granted' | 'refund_pending'
  errorMessage?: string
}

export async function autoRefundFailedReport(
  gradeId: string,
  deps: AutoRefundDeps,
): Promise<AutoRefundResult>
```

Logic:
1. `listStripePaymentsByGrade(gradeId)`. Filter to the payment with `status==='paid'`. If none, return `skipped_not_paid` (never paid, or already refunded).
2. Fetch the grade for user email, domain (for the notification email).
3. Branch on `payment.kind`:
   - `'report'`: call `billing.refund(payment.sessionId)`. On ok: `updateStripePaymentStatus(sessionId, { status: 'refunded' })`. On fail: `{ status: 'refund_pending' }`, log `[auto-refund-failed]`, operator email. Return accordingly.
   - `'credits'`: the audit row created by `/redeem-credit` (sessionId format `cs_credit_<gradeId>` or similar — check code). Increment `users.credits += 1` via new `store.incrementCredits(userId, delta)` method inside a transaction that also flips the audit row's status to `'refunded'`. Return `credit_granted`.
4. Publish `report.refunded` via `publishGradeEvent`.
5. Send user email via `mailer.sendRefundNotice({ to, domain, kind })`.

All failures inside the refund flow are caught at the boundary; any unexpected throw becomes `refund_pending` with a loud log.

### 3.3 Worker `.on('failed')` listener

In `src/queue/workers/generate-report/index.ts`:

```ts
worker.on('failed', (job, err) => {
  if (!job) return
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return  // will retry; not final
  void autoRefundFailedReport(job.data.gradeId, deps).catch((fatal) => {
    console.error('[auto-refund-boundary]', job.data.gradeId, fatal)
  })
})
```

Non-blocking. If it fails catastrophically, we log. Admin dashboard (future) shows `refund_pending` rows.

### 3.4 `Mailer.sendRefundNotice`

Interface extension:

```ts
export interface RefundNoticeMessage {
  to: string
  domain: string          // the graded site, for context
  kind: 'credit' | 'stripe'
}

export interface Mailer {
  sendMagicLink(msg: MagicLinkMessage): Promise<void>
  sendRefundNotice(msg: RefundNoticeMessage): Promise<void>
}
```

`ConsoleMailer`: `console.log('[refund-notice]', msg)`.

`ResendMailer`: sends a plain HTML email:
> "Your GEO Report for {domain} couldn't be generated after three tries. We've {refunded $19 to your card / restored your credit}. Try again when you're ready."

### 3.5 New SSE event + reducer state

`src/queue/events.ts`:
```ts
| { type: 'report.refunded'; refundKind: 'credit' | 'stripe'; reason?: string }
```

`src/web/lib/types.ts`: mirror. Extend `PaidStatus` to `'none' | 'checking_out' | 'generating' | 'ready' | 'failed' | 'refunded'`.

Reducer case:
```ts
case 'report.refunded':
  return { ...state, paidStatus: 'refunded', paidRefundKind: event.refundKind, reportPhase: null }
```

Add `paidRefundKind: 'credit' | 'stripe' | null` to `GradeState`.

SSE subscription: add `'report.refunded'` to the auto-close list alongside `'report.done'` / `'report.failed'`.

### 3.6 `PaidReportStatus` — new `refunded` branch

```tsx
if (status === 'refunded') {
  return (
    <div className="mt-6 border border-[var(--color-good)] p-4">
      <div className="text-sm text-[var(--color-fg)] mb-1">
        Refunded — the report couldn't be generated.
      </div>
      <div className="text-xs text-[var(--color-fg-muted)]">
        {refundKind === 'credit'
          ? 'Your credit is back on your account.'
          : 'Your $19 payment has been refunded to your card (takes 5-10 business days).'}
      </div>
    </div>
  )
}
```

### 3.7 Retrofit script

`scripts/refund-failed-reports.ts`: connects to the prod DB + Stripe, scans for candidates, runs `autoRefundFailedReport` on each. Dry-run flag (`--dry-run`) prints what it would do.

### 3.8 Schema — `stripe_payments.status`

Add `'refund_pending'` to the enum if not present. Check current schema; if it's already a text column with no enum constraint, no migration needed.

## 4. Testing

Unit:
- `autoRefundFailedReport` — 7 cases: no payment (skip), already refunded (skip), stripe success, stripe failure → refund_pending, credit success, credit on deleted user (skip), emits report.refunded event
- `BillingClient.refund` — FakeStripe path: records the refund, default ok
- `FakeStripe.failRefundsFor` helper works

Integration (testcontainers):
- Worker `.on('failed')` listener fires autoRefund when attempts exhausted
- Idempotency: triggering twice only refunds once
- Real `stripe_payments.status` transitions

Frontend unit:
- Reducer handles `report.refunded`
- PaidReportStatus renders refund copy for both kinds

## 5. Files touched

Create:
- `src/queue/workers/generate-report/auto-refund.ts`
- `scripts/refund-failed-reports.ts`
- Tests (as listed above)

Modify:
- `src/billing/types.ts`, `src/billing/stripe-client.ts`
- `src/mail/types.ts`, `src/mail/console-mailer.ts`, `src/mail/resend-mailer.ts`
- `src/queue/events.ts`, `src/queue/workers/generate-report/index.ts`
- `src/store/types.ts`, `src/store/postgres.ts`, `tests/unit/_helpers/fake-store.ts`, `tests/unit/_helpers/fake-stripe.ts`
- `src/web/lib/types.ts`, `src/web/lib/grade-reducer.ts`, `src/web/components/PaidReportStatus.tsx`
- Worker entrypoint (`src/worker/worker.ts` or equivalent) — wire billing + mailer into deps
- Existing test helpers that mock the mailer — add the new method stub

## 6. Out of scope

- Admin dashboard — listed in the production checklist separately.
- Partial refunds (refund only the tokens consumed) — too complex, all-or-nothing is simpler.
- Configurable retry count — 3 is fine for now.
- Supporting recovery via "retry after refund" (user paid again) — they can pay again if they want; this is a pure refund.

## 7. Risks

- **Stripe rate-limits on refunds** — if a huge batch of jobs fail simultaneously, we might hit Stripe's API limits. Mitigation: `refund_pending` fallback + admin flow. Acceptable for MVP.
- **Mailer failure** — Resend outage. The refund is already applied; the email is a nicety. Log the failure, don't block the flow.
- **Double refund** — idempotency via `stripe_payments.status` check. If two listener invocations race, one will find status='refunded' and skip.
- **User deleted account between payment and failure** — for credit redemption, user row is gone. Skip the credit grant; log. Stripe refund path is unaffected (payment intent doesn't need a user).
