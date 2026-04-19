# GEO Reporter — Credits Pack design

> Sub-spec for the credits feature (slotted between Plan 8 — Stripe paywall and Plan 9 — report rendering). Brainstormed 2026-04-19. Adds a $29 credit pack (10 paid reports) as a cheaper power-user upsell alongside the existing $19 one-off report. Simplifies the rate-limit tier to anonymous/verified/credit-holder and drops the email-verified quota bonus from Plan 7.

## 1. Scope

The existing product has two purchase flows: free (3/24h or 13/24h with email) and $19 one-off report. Users who want multiple reports must pay $19 × N — steep for agencies or power users. This spec adds a credit pack: $29 buys 10 credits, each credit redeems for one full paid report (same 4-provider + recommendation LLM pipeline as the $19 flow). As a side-effect, the rate-limit model collapses from 2 tiers to 3: email-verified returns to 3/24h (no bonus), and credits-on-file grants 10/24h.

**In scope**
- `users.credits` integer column + store methods (`getCredits`, `grantCredits`, `redeemCredit`).
- `stripe_payments.kind` enum column (`'report' | 'credits'`) + migration.
- `POST /billing/buy-credits` route — Stripe Checkout for the $29 pack.
- `POST /billing/redeem-credit` route — transactional credit decrement + enqueue `generate-report`.
- Webhook branching: `metadata.type === 'credits'` → grant 10 credits; `metadata.gradeId` → existing report-enqueue path.
- Rate-limit middleware: 3-tier branch (anon 3, verified 3, credits-on-file 10).
- Frontend: `BuyReportButton` branches on `useAuth().credits`; credit badge in Header; "Buy 10 for $29" CTAs on Landing + post-report success.
- `STRIPE_CREDITS_PRICE_ID` env var (required in production).
- Landing page URL-param toasts: `?credits=purchased`, `?credits=canceled`.

**Out of scope**
- Account/settings page — credit balance + purchase happen via Header badge + LandingPage CTA for MVP.
- Admin credit-grant UI — direct SQL for MVP.
- Formal refund policy on partial consumption — production-checklist item.
- Credit expiration — MVP: never expire.
- Subscription / auto-renewal — explicitly rejected during brainstorm (credits are one-off purchases).
- Bulk packs beyond 10 (e.g., 50 for $99) — MVP is single SKU.

## 2. Decisions locked in on 2026-04-19

| # | Decision | Choice | Why |
|---|---|---|---|
| C-1 | Credit semantic | Each credit = one full 4-provider paid report | Positions credits as a bulk-discount on reports (~85% off vs $19 × 10). "Scorecard-only" credits (Q1-B) won't sell. |
| C-2 | Email-verified quota bonus | DROP — verified = 3/24h (same as anonymous) | Simplifies rate-limit model to 3 tiers. Email becomes pure identity (credit balance portability). |
| C-3 | One-off $19 report | KEEP — coexists with $29 credits | Preserves low-commitment conversion point. Credit pack is an upsell, not a replacement. |
| C-4 | Rate-limit cap for credit holders | 10/24h while `credits > 0` | Matches pack size (mental model: "10 credits, 10 grades/day"). Balances customer latitude vs. scraping-abuse risk. |
| C-5 | Credit expiration | Never | Simplifies UX + revenue recognition for MVP. Revisit if unused-balance liability grows. |
| C-6 | Migration grant for existing verified users | None | Pre-launch; no real users to grandfather. |

## 3. Architecture

```
src/config/env.ts                         MODIFY — add STRIPE_CREDITS_PRICE_ID

src/billing/
└── prices.ts                             MODIFY — add CREDITS_PACK_CENTS + CREDITS_PACK_COUNT constants

src/db/schema.ts                          MODIFY — add users.credits + stripe_payments.kind
src/db/migrations/NNNN_add_credits.sql    NEW — additive schema migration

src/store/
├── types.ts                              MODIFY — add credits methods; extend getCookieWithUser to return credits
└── postgres.ts                           MODIFY — implement credits methods (transactional)

src/server/
├── middleware/
│   └── rate-limit.ts                     MODIFY — 3-tier branch (anon / verified / credits-holder)
└── routes/
    └── billing.ts                        MODIFY — add /buy-credits + /redeem-credit; branch webhook on metadata.type

src/web/
├── lib/
│   ├── api.ts                            MODIFY — add postBillingBuyCredits + postBillingRedeemCredit
│   └── types.ts                          MODIFY — add credits to AuthMeResponse
├── hooks/
│   └── useAuth.ts                        MODIFY — expose credits
├── components/
│   ├── BuyReportButton.tsx               MODIFY — branch on credits (redeem vs Stripe)
│   ├── CreditBadge.tsx                   NEW — small pill in Header for verified+credits users
│   ├── Header.tsx                        MODIFY — render CreditBadge when credits > 0
│   ├── BuyCreditsCTA.tsx                 NEW — landing + post-report "10 for $29" CTA
│   └── CreditsPurchasedToast.tsx         NEW — ?credits=purchased / =canceled toasts
└── pages/
    ├── LandingPage.tsx                   MODIFY — render BuyCreditsCTA for signed-in users; handle ?credits=* params
    └── LiveGradePage.tsx                 MODIFY — render BuyCreditsCTA inside PaidReportStatus "ready" banner

tests/unit/
├── _helpers/fake-store.ts                MODIFY — credits methods on FakeStore
├── store/fake-store-credits.test.ts      NEW — grant/redeem/race semantics
├── server/middleware/rate-limit.test.ts  MODIFY — update 2-tier assertions → 3-tier
├── server/routes/
│   ├── billing-buy-credits.test.ts       NEW — ~5 cases
│   ├── billing-redeem-credit.test.ts     NEW — ~5 cases
│   └── billing-webhook.test.ts           MODIFY — add credits-branch cases
└── web/components/
    ├── BuyReportButton.test.tsx          MODIFY — add credit-branch test
    ├── CreditBadge.test.tsx              NEW
    └── BuyCreditsCTA.test.tsx            NEW

tests/integration/
├── store-credits.test.ts                 NEW — real PG transactional semantics
├── billing-buy-credits.test.ts           NEW — full webhook → grant round-trip
└── billing-redeem-credit.test.ts         NEW — full redeem → job enqueue → generate-report

.env.example                              MODIFY — document STRIPE_CREDITS_PRICE_ID
docs/production-checklist.md              MODIFY — 3 new deferred items
docs/superpowers/specs/2026-04-17-geo-reporter-design.md MODIFY — anchor in §7.3 or §11
README.md                                 MODIFY — tier model + CTAs + roadmap
```

## 4. Rate-limit changes

`src/server/middleware/rate-limit.ts`'s `checkRateLimit` grows one branch:

```ts
const row = await store.getCookieWithUserAndCredits(cookie)
const limit =
  (row?.credits ?? 0) > 0 ? CREDITS_LIMIT :   // NEW: 10/24h
  row?.userId ? ANON_LIMIT :                   // CHANGED: was VERIFIED_LIMIT (13)
  ANON_LIMIT                                   // 3/24h
```

Where `CREDITS_LIMIT = 10` and `ANON_LIMIT = 3`. `VERIFIED_LIMIT = 13` is removed.

**Key invariant:** email verification alone no longer grants extra grades. The only paths to >3/24h are (a) holding credits, or (b) future subscription / special grants.

The existing `getCookieWithUser` store method is extended (or renamed to `getCookieWithUserAndCredits`) to return `{ cookie, userId, email, credits }` in a single query — joins `cookies LEFT JOIN users`. `users.credits` is `0` when no user is bound.

**Race-proofing:** the 10-credit limit is about grade *creation* (LLM-probe cost). A user with `credits > 0` can create up to 10 grades in 24h; each `POST /billing/redeem-credit` decrements one credit. If a user burns all 10 credits on reports, their credit balance → 0, and they drop back to 3/24h for future free-tier grades in the rolling window. This is fine — credits run out, grading cap shrinks.

## 5. Purchase flow ($29 for 10 credits)

### 5.1 `POST /billing/buy-credits`

Cookie-auth'd. No body (the pack SKU is fixed).

1. Load cookie → user. If `user.userId === null` → `409 { error: 'must_verify_email' }`.
2. Create Stripe Checkout Session:
   - `mode: 'payment'`
   - `line_items: [{ price: env.STRIPE_CREDITS_PRICE_ID, quantity: 1 }]`
   - `metadata: { type: 'credits', userId: user.userId, creditCount: '10' }` (Stripe metadata values are strings)
   - `client_reference_id: user.userId`
   - `success_url: ${env.PUBLIC_BASE_URL}/?credits=purchased`
   - `cancel_url: ${env.PUBLIC_BASE_URL}/?credits=canceled`
3. Insert `stripe_payments { gradeId: null, sessionId, kind: 'credits', status: 'pending', amountCents: CREDITS_PACK_CENTS, currency: 'usd' }`.
4. Return `{ url: session.url }`.

**Note on `stripe_payments.gradeId`:** currently NOT NULL in the Plan 1 schema. The migration in §7 makes it NULLABLE. Credits purchases have no associated grade at purchase time.

### 5.2 Webhook branch extension

`POST /billing/webhook` already handles `checkout.session.completed` + idempotency via `stripe_payments.sessionId`. The handler gains a fork:

```ts
// after signature verify + row lookup + idempotency guard
if (row.kind === 'credits') {
  const userId = event.data.object.metadata?.userId
  const creditCount = Number(event.data.object.metadata?.creditCount ?? 0)
  if (!userId || !Number.isInteger(creditCount) || creditCount < 1) {
    return c.json({ error: 'malformed_credits_metadata' }, 400)
  }
  // Transactional: flip payment status + grant credits
  await deps.store.grantCreditsAndMarkPaid(sessionId, userId, creditCount, amountCents, currency)
  return c.body(null, 200)
}
// else: existing report path — flip + enqueue generate-report
```

The `grantCreditsAndMarkPaid` store method wraps both writes in one transaction so we can't grant credits without recording payment (or vice-versa). Idempotency still comes from the outer `row.status === 'paid'` early-exit; Stripe retries are ACK'd 200 with no further work.

**Failure mode:** if the webhook fires, the row flips to 'paid', credits are granted, and the response fails to send — Stripe retries, we see `status='paid'`, we early-exit. Net: exactly-once credit grant.

## 6. Redemption flow (spend 1 credit on a grade)

### 6.1 `POST /billing/redeem-credit`

Cookie-auth'd. Body: `{ gradeId }` (Zod UUID-validated).

1. Load grade. 404 if missing or cookie mismatch.
2. 409 if `grade.status !== 'done'`.
3. 409 `already_paid` if grade already has `tier='paid'` OR any `stripe_payments` row for this grade has `status='paid'` (covers both $19 and prior credit redeems).
4. Load user via cookie. 409 `must_verify_email` if `userId === null`.
5. Call transactional `store.redeemCredit(userId)`:
   ```sql
   UPDATE users SET credits = credits - 1
     WHERE id = $1 AND credits > 0
     RETURNING credits
   ```
   If the UPDATE affected 0 rows → return `{ ok: false }` from the store method → route returns `409 no_credits`.
6. On successful decrement: insert `stripe_payments { gradeId, sessionId: 'credit:' + gradeId, kind: 'credits', status: 'paid', amountCents: 0, currency: 'usd' }` as the audit trail. The `sessionId` prefix prevents collision with Stripe-issued IDs and doubles as a BullMQ-friendly tag.
7. Enqueue `generate-report` job with `{ gradeId, sessionId: 'credit:' + gradeId }` — same job the $19 webhook enqueues. Deterministic `jobId: 'generate-report-credit:' + gradeId` so retries dedup.
8. Return `204`.

**Race at step 5:** two simultaneous redeem requests for `credits=1`. Postgres serializes UPDATE; only one wins. The loser gets `RETURNING` with no row → `{ ok: false }` → 409.

**Failure after decrement but before enqueue:** rare but possible. The single-transaction approach wraps the UPDATE + the audit-row INSERT + calls BullMQ's `add` inside the same tx boundary. If `enqueue` throws, the DB rolls back (credit not spent). Safe.

### 6.2 Audit semantics

The `stripe_payments` table becomes the single source of truth for "was this grade paid for, and how?" A grade has `tier='paid'` IFF some row in `stripe_payments` has `gradeId = grade.id AND status = 'paid'`. The `kind` column distinguishes `'report'` (Stripe $19) from `'credits'` (credit redeem). Queries for "what's the revenue breakdown for this month?" read from this table, joining on `stripe_checkout_session_id` where needed.

## 7. Data model

Two migrations (combined into one file: `NNNN_credits_pack.sql`):

```sql
-- 1. credits balance on users
ALTER TABLE users ADD COLUMN credits integer NOT NULL DEFAULT 0;

-- 2. kind column on stripe_payments + relax NOT NULL on gradeId
ALTER TABLE stripe_payments ADD COLUMN kind text NOT NULL DEFAULT 'report'
  CHECK (kind IN ('report', 'credits'));
ALTER TABLE stripe_payments ALTER COLUMN grade_id DROP NOT NULL;
```

`drizzle-kit` generates the migration; the `DEFAULT 'report'` handles existing rows.

**Store interface extensions** (`GradeStore` in `src/store/types.ts`):

```ts
// Existing method, extended return shape:
getCookieWithUserAndCredits(cookie: string): Promise<{
  cookie: string
  userId: string | null
  email: string | null
  credits: number  // 0 if no user bound
}>

// New methods:
getCredits(userId: string): Promise<number>
grantCreditsAndMarkPaid(
  sessionId: string,
  userId: string,
  creditCount: number,
  amountCents: number,
  currency: string,
): Promise<void>
redeemCredit(userId: string): Promise<{ ok: true; remaining: number } | { ok: false }>
```

`getCookieWithUserAndCredits` replaces `getCookieWithUser` in consumers that need the balance (rate-limit middleware, `/auth/me`). The existing method stays for callers that don't need credits.

## 8. Frontend

### 8.1 `useAuth` extension

`/auth/me` response shape grows:

```ts
{ verified: true, email: string, credits: number } | { verified: false }
```

`useAuth` hook exposes `credits: number` (defaults to 0 when unverified).

### 8.2 `BuyReportButton` branching

Label + action depend on `useAuth().credits`:

| State | Label | Action |
|---|---|---|
| `credits === 0` | `Get the full report — $19` | Existing `postBillingCheckout(gradeId)` — Stripe redirect |
| `credits > 0` | `Redeem 1 credit (${credits - 1} left)` | New `postBillingRedeemCredit(gradeId)` |

On successful redeem: the existing `useGradeEvents` subscription picks up `report.started` events as the worker runs, transitioning `paidStatus` through `generating` → `ready` — identical to the Stripe path. No UI bifurcation post-purchase.

### 8.3 `CreditBadge`

Small pill rendered in `Header` when signed in AND `credits > 0`: `7 credits` styled with the `--color-good` accent. Clicking it opens a minimal modal/tooltip: "You have 7 credits. Each redeems for one full paid report. [Buy more →]." For MVP, the click can just link to the LandingPage CTA anchor.

### 8.4 `BuyCreditsCTA`

Small bordered card: `💎 Save 85% — 10 reports for $29`. Single button: `Get credits`. Renders in two places:

1. LandingPage below the URL input — only for signed-in users (`useAuth().verified === true`). Hidden for anonymous users (they'd need to verify first, so the tier progression is: run a free grade → hit email gate → verify → see credits upsell).
2. LiveGradePage inside `PaidReportStatus` when `paidStatus === 'ready'`. "Next report waiting? Grab 10 for $29." Visible whether the report was bought via $19 Stripe OR redeemed via credit.

### 8.5 `CreditsPurchasedToast` + URL param handling

LandingPage extends its `?verified=1` / `?auth_error=` param logic with two more:
- `?credits=purchased` → Toast: `🎉 10 credits added.` (5s auto-dismiss).
- `?credits=canceled` → Toast: `Checkout canceled — no charge.`

Both strip the param via `history.replaceState` on mount.

## 9. Env vars

New in `src/config/env.ts`:

```ts
STRIPE_CREDITS_PRICE_ID: z.string().startsWith('price_').optional()
```

Added to `superRefine`'s `required` list under `NODE_ENV === 'production'`. Dev: optional; `/billing/buy-credits` returns `503 stripe_credits_not_configured` when unset (the existing Stripe-route feature flag covers this pattern already).

`.env.example` documents it next to the existing `STRIPE_PRICE_ID`:

```
# STRIPE_CREDITS_PRICE_ID: the Stripe-side price for the 10-credit pack ($29).
# Create once in the Stripe dashboard; distinct from STRIPE_PRICE_ID (the $19 one-off).
# STRIPE_CREDITS_PRICE_ID=
```

## 10. Testing

### 10.1 Unit

- **Store methods (`fake-store-credits.test.ts`):** grant adds to balance; redeem decrements and returns `ok: true, remaining`; redeem on `credits=0` returns `ok: false`; simulated concurrent redeems see exactly one winner.
- **Rate-limit middleware:** existing tests updated — verified-no-credits is now `limit: 3` (was 13); new cases: credits-holder `limit: 10`; falling below credits=0 returns to 3 on next call.
- **`POST /billing/buy-credits` (`billing-buy-credits.test.ts`, ~5 cases):** happy (creates session + inserts pending row + returns URL); unverified → 409; Stripe not configured → 503; pending credits session — resume OR start new (match /checkout's logic); idempotency of a retried webhook.
- **`POST /billing/redeem-credit` (`billing-redeem-credit.test.ts`, ~5 cases):** happy (decrements + enqueues job + inserts audit row); not owner → 404; grade not done → 409; credits=0 → 409; already-paid grade → 409; concurrent redeem race → one wins.
- **Webhook branch (`billing-webhook.test.ts` extensions):** `metadata.type='credits'` happy; malformed metadata → 400; idempotent on retry; doesn't double-grant.
- **Frontend:** `BuyReportButton` label branching on credits; `CreditBadge` visibility gating; LandingPage `?credits=purchased` toast.

### 10.2 Integration (testcontainers)

- **`store-credits.test.ts`:** PG transactional redeem (seed user with credits=2, redeem twice concurrently, assert exactly one failure).
- **`billing-buy-credits.test.ts`:** construct signed Stripe event locally → POST to webhook → assert credits granted + `stripe_payments.status='paid'` + `.kind='credits'`.
- **`billing-redeem-credit.test.ts`:** seed a free+done grade + user with credits → POST redeem → run real `generate-report` worker → assert `grade.tier='paid'` + recs written + credits decremented.

### 10.3 Targets

~25 new unit tests, 3 integration tests. Project totals after this plan: ~475 unit / ~75 integration.

## 11. Production-checklist diff

### 11.1 Added

- **Partial-consumption refund policy.** Credits are a bulk purchase; a user who has used 4 of 10 and requests a refund needs a defined policy. MVP: support-ticket-driven, manual partial refund via Stripe admin. Before scale: formal policy (e.g., ≤2 credits used = full refund; 3–5 = 50%; >5 = no refund; all within 14 days).
- **Admin credit-grant UI.** Direct SQL today (`UPDATE users SET credits = credits + 3 WHERE email = '...'`). Needs a simple admin endpoint once support volume grows.
- **Credit expiration policy (deferred).** MVP: never expire. Revisit if unused balances accumulate past 12 months — 2-year expiration post-purchase with a 30-day email warning is a reasonable future default.

### 11.2 Unchanged

All Plan 7 / Plan 8 / OpenRouter-fallback deferred items remain in place. The rate-limit-atomicity item now covers three buckets (grade, magic-email, magic-ip) plus the 3-tier branch.

## 12. Master-spec anchor

§7.3 (Paid tier) gets a new paragraph:

> **Credit packs (added 2026-04-19).** Alongside the $19 one-off, users can buy 10 credits for $29 via a separate Stripe Checkout product. Each credit redeems for one full paid report at any time (same `generate-report` pipeline). Email verification is required to hold credits (balance portability across cookies/devices). Rate-limit tier rises to 10/24h while `users.credits > 0`. See `docs/superpowers/specs/2026-04-19-geo-reporter-credits-pack-design.md`.

---

**Open points at spec-write time (none expected to change the design):**
- Exact UI copy for CTAs + toasts — polish at implementation time.
- Whether `CreditBadge` opens a dropdown/modal or just links to the Landing CTA — UI-level; modal is cleaner but costs one more component. Either is fine.
- Minimum credits for the badge to render (currently: any credit > 0). If we want to hide balance of 1 as "nearly empty," threshold adjusts later.
