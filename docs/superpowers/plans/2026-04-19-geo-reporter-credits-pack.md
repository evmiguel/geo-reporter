# GEO Reporter — Credits Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a $29 credit pack (10 paid-report credits) as an alternative to the $19 one-off, collapse the email-verified rate-limit bonus, and surface credit balance + redeem flow in the UI.

**Architecture:** Additive schema change (`users.credits` + `stripe_payments.kind`). Two new billing routes (`/billing/buy-credits` + `/billing/redeem-credit`) reuse the existing Stripe + webhook infrastructure. Rate-limit middleware grows a third branch. Frontend extends `useAuth` with a credit balance and branches `BuyReportButton` between redeem and Stripe checkout.

**Tech Stack:** TypeScript 5.6+ strict, Hono 4, Drizzle 0.33, Stripe 17, BullMQ 5, React 18, vitest 2 + testcontainers 10. Zero new runtime deps.

---

## Spec references

- Sub-spec (source of truth): `docs/superpowers/specs/2026-04-19-geo-reporter-credits-pack-design.md`
- Master spec: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` §7.3.

**Decisions locked in on 2026-04-19:**

- C-1: Each credit = one full 4-provider paid report.
- C-2: Email-verified quota DROPS from 13/24h to 3/24h. Email = identity only.
- C-3: $19 one-off and $29 credits coexist.
- C-4: Credit holders get 10/24h grading cap while `credits > 0`.
- C-5: Credits never expire.
- C-6: No migration grant (pre-launch).

---

## File structure

```
src/config/env.ts                         MODIFY — add STRIPE_CREDITS_PRICE_ID
src/billing/prices.ts                     MODIFY — add CREDITS_PACK_CENTS + CREDITS_PACK_COUNT

src/db/schema.ts                          MODIFY — users.credits + stripe_payments.kind; grade_id nullable
src/db/migrations/NNNN_credits_pack.sql   NEW — drizzle-kit generated

src/store/
├── types.ts                              MODIFY — add credits interface methods; extend getCookieWithUser
└── postgres.ts                           MODIFY — implement transactional credits methods

src/server/
├── middleware/rate-limit.ts              MODIFY — 3-tier branch
└── routes/billing.ts                     MODIFY — add /buy-credits + /redeem-credit; webhook branch

src/web/
├── lib/
│   ├── api.ts                            MODIFY — postBillingBuyCredits + postBillingRedeemCredit
│   └── types.ts                          MODIFY — AuthMeResponse.credits
├── hooks/useAuth.ts                      MODIFY — expose credits
├── components/
│   ├── BuyReportButton.tsx               MODIFY — branch on credits
│   ├── CreditBadge.tsx                   NEW
│   ├── Header.tsx                        MODIFY — render CreditBadge
│   ├── BuyCreditsCTA.tsx                 NEW
│   └── CreditsPurchasedToast.tsx         NEW
└── pages/
    ├── LandingPage.tsx                   MODIFY — BuyCreditsCTA + ?credits toasts
    └── LiveGradePage.tsx                 MODIFY — BuyCreditsCTA in PaidReportStatus

tests/unit/
├── _helpers/fake-store.ts                MODIFY — credits methods
├── store/
│   └── fake-store-credits.test.ts        NEW
├── server/
│   ├── middleware/rate-limit.test.ts     MODIFY — 3-tier assertions
│   └── routes/
│       ├── billing-buy-credits.test.ts   NEW
│       ├── billing-redeem-credit.test.ts NEW
│       └── billing-webhook.test.ts       MODIFY — credits branch
└── web/
    ├── components/
    │   ├── BuyReportButton.test.tsx      MODIFY
    │   ├── CreditBadge.test.tsx          NEW
    │   └── BuyCreditsCTA.test.tsx        NEW
    └── hooks/useAuth.test.tsx            MODIFY

tests/integration/
├── store-credits.test.ts                 NEW — PG transactional race test
├── billing-buy-credits.test.ts           NEW — webhook → grant round-trip
└── billing-redeem-credit.test.ts         NEW — redeem → worker → tier='paid'

.env.example                              MODIFY — STRIPE_CREDITS_PRICE_ID
docs/production-checklist.md              MODIFY — 3 new deferred items
docs/superpowers/specs/2026-04-17-geo-reporter-design.md  MODIFY — §7.3 anchor
README.md                                 MODIFY — tier table + CTAs + roadmap
```

---

## Project constraints (from CLAUDE.md)

- `.ts` extensions on ALL imports (Node ESM).
- `import type` for type-only imports (`verbatimModuleSyntax: true`).
- `exactOptionalPropertyTypes: true` — conditionally spread optional fields.
- `noUncheckedIndexedAccess: true`.
- Store access goes through `GradeStore`; `PostgresStore` is the only impl.
- Git commits: inline identity only:
  ```
  git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit ...
  ```

---

## Task 1: Env var + price constants

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/billing/prices.ts`
- Modify: `.env.example`
- Test: `tests/unit/config/env.test.ts`

- [ ] **Step 1: Append failing env test cases**

Append to `tests/unit/config/env.test.ts`:

```ts
describe('env — credits pack', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o',
    GEMINI_API_KEY: 'sk-g', PERPLEXITY_API_KEY: 'sk-p',
    COOKIE_HMAC_KEY: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'http://localhost:5173',
    STRIPE_SECRET_KEY: 'sk_live_abc',
    STRIPE_WEBHOOK_SECRET: 'whsec_abc',
    STRIPE_PRICE_ID: 'price_abc',
  }

  it('accepts missing STRIPE_CREDITS_PRICE_ID in development', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development' })
    expect(env.STRIPE_CREDITS_PRICE_ID).toBeUndefined()
  })

  it('rejects STRIPE_CREDITS_PRICE_ID without price_ prefix', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', STRIPE_CREDITS_PRICE_ID: 'abc' }))
      .toThrow(/STRIPE_CREDITS_PRICE_ID/)
  })

  it('requires STRIPE_CREDITS_PRICE_ID in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/STRIPE_CREDITS_PRICE_ID/)
  })

  it('accepts fully-configured production env', () => {
    const env = loadEnv({
      ...base, NODE_ENV: 'production',
      STRIPE_CREDITS_PRICE_ID: 'price_credits_abc',
    })
    expect(env.STRIPE_CREDITS_PRICE_ID).toBe('price_credits_abc')
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

`pnpm test -- tests/unit/config/env.test.ts`

- [ ] **Step 3: Extend the schema**

In `src/config/env.ts`, add inside `z.object({...})` after `STRIPE_PRICE_ID`:

```ts
STRIPE_CREDITS_PRICE_ID: z.string().startsWith('price_').optional(),
```

In the `superRefine`'s `required` array, add `'STRIPE_CREDITS_PRICE_ID'`:

```ts
const required = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY',
  'COOKIE_HMAC_KEY', 'PUBLIC_BASE_URL',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID',
  'STRIPE_CREDITS_PRICE_ID',
] as const
```

- [ ] **Step 4: Run tests — expect PASS**

`pnpm test -- tests/unit/config/env.test.ts`

- [ ] **Step 5: Extend `src/billing/prices.ts`**

Append:

```ts
export const CREDITS_PACK_CENTS = 2900
export const CREDITS_PACK_COUNT = 10
```

- [ ] **Step 6: Append to `.env.example`**

```
# STRIPE_CREDITS_PRICE_ID: the Stripe-side price for the 10-credit pack ($29).
# Create once in the Stripe dashboard; distinct from STRIPE_PRICE_ID (the $19 one-off).
# STRIPE_CREDITS_PRICE_ID=
```

- [ ] **Step 7: Full validation + commit**

`pnpm test`, `pnpm typecheck` clean.

```bash
git add src/config/env.ts src/billing/prices.ts tests/unit/config/env.test.ts .env.example
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): add STRIPE_CREDITS_PRICE_ID env + pack constants"
```

---

## Task 2: Schema migration — users.credits + stripe_payments.kind

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/NNNN_credits_pack.sql` (generated via drizzle-kit)

- [ ] **Step 1: Update `src/db/schema.ts`**

In the `users` table definition, add `credits`:

```ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  credits: integer('credits').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

In the `stripePayments` table, add `kind` and relax `gradeId`:

```ts
export const stripePayments = pgTable('stripe_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  gradeId: uuid('grade_id').references(() => grades.id, { onDelete: 'cascade' }),  // dropped .notNull()
  sessionId: text('session_id').notNull().unique(),
  kind: text('kind', { enum: ['report', 'credits'] }).notNull().default('report'),  // NEW
  status: text('status', { enum: ['pending', 'paid', 'refunded', 'failed'] }).notNull().default('pending'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byGrade: index('stripe_payments_grade_id_idx').on(t.gradeId),
}))
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm db:generate
```

This creates a new file `src/db/migrations/NNNN_<random-name>.sql`. Open it and confirm it contains:

```sql
ALTER TABLE "users" ADD COLUMN "credits" integer DEFAULT 0 NOT NULL;
ALTER TABLE "stripe_payments" ALTER COLUMN "grade_id" DROP NOT NULL;
ALTER TABLE "stripe_payments" ADD COLUMN "kind" text DEFAULT 'report' NOT NULL;
```

(drizzle-kit may emit slightly different SQL — as long as the three alterations land, the file is good.)

- [ ] **Step 3: Run the migration against the dev DB**

```bash
docker compose up -d
pnpm db:migrate
```

Verify by querying Postgres:

```bash
docker compose exec postgres psql -U geo geo -c '\d users'
docker compose exec postgres psql -U geo geo -c '\d stripe_payments'
```

Expected: `credits` on users, `kind` on stripe_payments, `grade_id` nullable.

- [ ] **Step 4: Update the schema unit test**

In `tests/unit/db/schema.test.ts`, if there's an existing test that introspects the schema, extend it with assertions for the new column. Otherwise, add a new test:

```ts
it('users table has credits column', () => {
  expect(schema.users).toHaveProperty('credits')
})

it('stripe_payments table has kind column', () => {
  expect(schema.stripePayments).toHaveProperty('kind')
})
```

- [ ] **Step 5: Run + commit**

`pnpm test`, `pnpm typecheck` clean.

```bash
git add src/db/schema.ts src/db/migrations/ tests/unit/db/schema.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(db): add users.credits + stripe_payments.kind"
```

---

## Task 3: Store — credits methods + getCookieWithUserAndCredits

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/postgres.ts`
- Modify: `tests/unit/_helpers/fake-store.ts`
- Test: `tests/unit/store/fake-store-credits.test.ts` (new)
- Test: `tests/integration/store-credits.test.ts` (new)

- [ ] **Step 1: Extend `GradeStore` interface**

In `src/store/types.ts`, after the magic-token / stripe-payment methods, add:

```ts
// Credits (Plan 8.5)
getCredits(userId: string): Promise<number>
grantCreditsAndMarkPaid(
  sessionId: string,
  userId: string,
  creditCount: number,
  amountCents: number,
  currency: string,
): Promise<void>
redeemCredit(userId: string): Promise<{ ok: true; remaining: number } | { ok: false }>
getCookieWithUserAndCredits(cookie: string): Promise<{
  cookie: string
  userId: string | null
  email: string | null
  credits: number
}>
```

- [ ] **Step 2: Write fake-store tests**

Create `tests/unit/store/fake-store-credits.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore credits', () => {
  it('getCredits returns 0 for new users', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    expect(await store.getCredits(user.id)).toBe(0)
  })

  it('grantCreditsAndMarkPaid adds to balance and flips payment status', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    await store.createStripePayment({
      gradeId: null as never, sessionId: 'cs_c1', amountCents: 2900, currency: 'usd',
    })
    await store.grantCreditsAndMarkPaid('cs_c1', user.id, 10, 2900, 'usd')
    expect(await store.getCredits(user.id)).toBe(10)
    const row = await store.getStripePaymentBySessionId('cs_c1')
    expect(row!.status).toBe('paid')
  })

  it('redeemCredit decrements balance and returns remaining', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    await store.createStripePayment({
      gradeId: null as never, sessionId: 'cs_c2', amountCents: 2900, currency: 'usd',
    })
    await store.grantCreditsAndMarkPaid('cs_c2', user.id, 10, 2900, 'usd')
    const first = await store.redeemCredit(user.id)
    expect(first).toEqual({ ok: true, remaining: 9 })
    const second = await store.redeemCredit(user.id)
    expect(second).toEqual({ ok: true, remaining: 8 })
  })

  it('redeemCredit returns ok:false when balance is 0', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    const result = await store.redeemCredit(user.id)
    expect(result).toEqual({ ok: false })
  })

  it('getCookieWithUserAndCredits returns credits for a bound cookie', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie('c-1', user.id)
    await store.createStripePayment({
      gradeId: null as never, sessionId: 'cs_c3', amountCents: 2900, currency: 'usd',
    })
    await store.grantCreditsAndMarkPaid('cs_c3', user.id, 10, 2900, 'usd')
    const result = await store.getCookieWithUserAndCredits('c-1')
    expect(result.credits).toBe(10)
    expect(result.userId).toBe(user.id)
    expect(result.email).toBe('u@x.com')
  })

  it('getCookieWithUserAndCredits returns 0 credits for unbound cookie', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-2')
    const result = await store.getCookieWithUserAndCredits('c-2')
    expect(result.credits).toBe(0)
    expect(result.userId).toBeNull()
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

`pnpm test -- tests/unit/store/fake-store-credits.test.ts`

- [ ] **Step 4: Implement in FakeStore**

In `tests/unit/_helpers/fake-store.ts`:

Extend the `users` map values to include credits (update the `User` type usage; if User type doesn't have credits yet, also update the corresponding type helper).

First, update the `upsertUser` and `usersMap` handling to include credits. The `User` type from `InferSelectModel<typeof schema.users>` will automatically pick up the new column after Task 2, so this should just work — but verify `makeFakeStore` initializes `credits: 0` when creating new user rows.

Then add the 4 new methods to the returned object (place them after the existing magic-token / stripe-payment methods):

```ts
async getCredits(userId: string): Promise<number> {
  const user = usersMap.get(userId)
  return user?.credits ?? 0
},

async grantCreditsAndMarkPaid(
  sessionId: string,
  userId: string,
  creditCount: number,
  amountCents: number,
  currency: string,
): Promise<void> {
  const user = usersMap.get(userId)
  if (!user) throw new Error(`FakeStore.grantCreditsAndMarkPaid: unknown user ${userId}`)
  usersMap.set(userId, { ...user, credits: user.credits + creditCount })
  const row = stripePaymentsMap.get(sessionId)
  if (!row) throw new Error(`FakeStore.grantCreditsAndMarkPaid: unknown session ${sessionId}`)
  stripePaymentsMap.set(sessionId, {
    ...row, status: 'paid',
    amountCents, currency, updatedAt: new Date(),
  })
},

async redeemCredit(userId: string): Promise<{ ok: true; remaining: number } | { ok: false }> {
  const user = usersMap.get(userId)
  if (!user || user.credits <= 0) return { ok: false }
  const remaining = user.credits - 1
  usersMap.set(userId, { ...user, credits: remaining })
  return { ok: true, remaining }
},

async getCookieWithUserAndCredits(cookie: string): Promise<{
  cookie: string; userId: string | null; email: string | null; credits: number
}> {
  const row = cookiesMap.get(cookie)
  if (!row) return { cookie, userId: null, email: null, credits: 0 }
  if (!row.userId) return { cookie, userId: null, email: null, credits: 0 }
  const user = usersMap.get(row.userId)
  return {
    cookie,
    userId: row.userId,
    email: user?.email ?? null,
    credits: user?.credits ?? 0,
  }
},
```

Note on `upsertUser`: make sure the initial `credits: 0` is set. Existing FakeStore creates `{ id, email, createdAt }`; add `credits: 0`.

- [ ] **Step 5: Run FakeStore tests — expect PASS**

`pnpm test -- tests/unit/store/fake-store-credits.test.ts` → 6 tests pass.

- [ ] **Step 6: Write integration test**

Create `tests/integration/store-credits.test.ts`:

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
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, cookies, users, magic_tokens CASCADE`)
})

describe('PostgresStore credits', () => {
  it('getCredits returns 0 initially; grantCreditsAndMarkPaid adds', async () => {
    const user = await store.upsertUser('u@example.com')
    expect(await store.getCredits(user.id)).toBe(0)
    await store.createStripePayment({
      gradeId: null as never, sessionId: 'cs_int_1', amountCents: 2900, currency: 'usd',
    })
    await store.grantCreditsAndMarkPaid('cs_int_1', user.id, 10, 2900, 'usd')
    expect(await store.getCredits(user.id)).toBe(10)
  })

  it('redeemCredit decrements; returns ok:false on empty', async () => {
    const user = await store.upsertUser('u@example.com')
    const empty = await store.redeemCredit(user.id)
    expect(empty).toEqual({ ok: false })

    await store.createStripePayment({
      gradeId: null as never, sessionId: 'cs_int_2', amountCents: 2900, currency: 'usd',
    })
    await store.grantCreditsAndMarkPaid('cs_int_2', user.id, 3, 2900, 'usd')

    const r1 = await store.redeemCredit(user.id)
    const r2 = await store.redeemCredit(user.id)
    const r3 = await store.redeemCredit(user.id)
    const r4 = await store.redeemCredit(user.id)

    expect(r1).toEqual({ ok: true, remaining: 2 })
    expect(r2).toEqual({ ok: true, remaining: 1 })
    expect(r3).toEqual({ ok: true, remaining: 0 })
    expect(r4).toEqual({ ok: false })
  })

  it('concurrent redeems on balance=1 — only one wins', async () => {
    const user = await store.upsertUser('u@example.com')
    await store.createStripePayment({
      gradeId: null as never, sessionId: 'cs_race', amountCents: 2900, currency: 'usd',
    })
    await store.grantCreditsAndMarkPaid('cs_race', user.id, 1, 2900, 'usd')

    const [a, b] = await Promise.all([
      store.redeemCredit(user.id),
      store.redeemCredit(user.id),
    ])
    const oks = [a, b].filter((r) => r.ok).length
    const fails = [a, b].filter((r) => !r.ok).length
    expect(oks).toBe(1)
    expect(fails).toBe(1)
    expect(await store.getCredits(user.id)).toBe(0)
  })

  it('getCookieWithUserAndCredits joins correctly', async () => {
    const user = await store.upsertUser('u@example.com')
    await store.upsertCookie('c-1', user.id)
    await store.createStripePayment({
      gradeId: null as never, sessionId: 'cs_int_3', amountCents: 2900, currency: 'usd',
    })
    await store.grantCreditsAndMarkPaid('cs_int_3', user.id, 5, 2900, 'usd')
    const result = await store.getCookieWithUserAndCredits('c-1')
    expect(result.credits).toBe(5)
    expect(result.email).toBe('u@example.com')
    expect(result.userId).toBe(user.id)
  })
})
```

- [ ] **Step 7: Run — expect FAIL**

`pnpm test:integration -- tests/integration/store-credits.test.ts`

- [ ] **Step 8: Implement in PostgresStore**

In `src/store/postgres.ts`, add `sql` import if missing:

```ts
import { eq, and, isNull, sql } from 'drizzle-orm'
```

Add the 4 methods (place after the existing stripe-payment methods):

```ts
async getCredits(userId: string): Promise<number> {
  const [row] = await this.db.select({ credits: schema.users.credits })
    .from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  return row?.credits ?? 0
}

async grantCreditsAndMarkPaid(
  sessionId: string,
  userId: string,
  creditCount: number,
  amountCents: number,
  currency: string,
): Promise<void> {
  await this.db.transaction(async (tx) => {
    await tx.update(schema.users)
      .set({ credits: sql`${schema.users.credits} + ${creditCount}` })
      .where(eq(schema.users.id, userId))
    await tx.update(schema.stripePayments)
      .set({ status: 'paid', amountCents, currency, updatedAt: new Date() })
      .where(eq(schema.stripePayments.sessionId, sessionId))
  })
}

async redeemCredit(userId: string): Promise<{ ok: true; remaining: number } | { ok: false }> {
  const [row] = await this.db.update(schema.users)
    .set({ credits: sql`${schema.users.credits} - 1` })
    .where(and(eq(schema.users.id, userId), sql`${schema.users.credits} > 0`))
    .returning({ credits: schema.users.credits })
  if (!row) return { ok: false }
  return { ok: true, remaining: row.credits }
}

async getCookieWithUserAndCredits(cookie: string): Promise<{
  cookie: string; userId: string | null; email: string | null; credits: number
}> {
  const [row] = await this.db
    .select({
      cookie: schema.cookies.cookie,
      userId: schema.cookies.userId,
      email: schema.users.email,
      credits: schema.users.credits,
    })
    .from(schema.cookies)
    .leftJoin(schema.users, eq(schema.users.id, schema.cookies.userId))
    .where(eq(schema.cookies.cookie, cookie))
    .limit(1)
  if (!row) return { cookie, userId: null, email: null, credits: 0 }
  return {
    cookie: row.cookie,
    userId: row.userId,
    email: row.email,
    credits: row.credits ?? 0,
  }
}
```

- [ ] **Step 9: Run integration test — expect PASS**

`pnpm test:integration -- tests/integration/store-credits.test.ts`

- [ ] **Step 10: Full validation + commit**

`pnpm test`, `pnpm test:integration`, `pnpm typecheck` all clean.

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts \
        tests/unit/store/fake-store-credits.test.ts tests/integration/store-credits.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): add credits methods with transactional grant + redeem"
```

---

## Task 4: Rate-limit middleware — 3-tier branch

**Files:**
- Modify: `src/server/middleware/rate-limit.ts`
- Modify: `tests/unit/server/middleware/rate-limit.test.ts`
- Modify: `tests/integration/rate-limit.test.ts`

- [ ] **Step 1: Update unit tests**

In `tests/unit/server/middleware/rate-limit.test.ts`, find the existing "verified cookies get limit 13" test and change its expectation to 3 (collapsed). Then add a new case for credit holders:

Replace the existing verified test with:

```ts
it('verified cookie (no credits) gets limit 3 (same as anonymous)', async () => {
  const redis = new (Redis as unknown as new () => Redis)()
  const store = makeFakeStore()
  const user = await store.upsertUser('u@x.com')
  const cookie = 'verified-no-credits'
  await store.upsertCookie(cookie, user.id)
  const ip = '1.1.1.1'
  for (let i = 0; i < 3; i++) {
    const r = await checkRateLimit(redis as never, store, ip, cookie)
    expect(r.allowed).toBe(true)
    expect(r.limit).toBe(3)
  }
  const blocked = await checkRateLimit(redis as never, store, ip, cookie)
  expect(blocked.allowed).toBe(false)
  expect(blocked.limit).toBe(3)
})
```

Add after it:

```ts
it('credit-holding cookie gets limit 10', async () => {
  const redis = new (Redis as unknown as new () => Redis)()
  const store = makeFakeStore()
  const user = await store.upsertUser('u@x.com')
  const cookie = 'verified-with-credits'
  await store.upsertCookie(cookie, user.id)
  await store.createStripePayment({
    gradeId: null as never, sessionId: 'cs_rl', amountCents: 2900, currency: 'usd',
  })
  await store.grantCreditsAndMarkPaid('cs_rl', user.id, 10, 2900, 'usd')

  const ip = '2.2.2.2'
  for (let i = 0; i < 10; i++) {
    const r = await checkRateLimit(redis as never, store, ip, cookie)
    expect(r.allowed).toBe(true)
    expect(r.limit).toBe(10)
  }
  const blocked = await checkRateLimit(redis as never, store, ip, cookie)
  expect(blocked.allowed).toBe(false)
  expect(blocked.limit).toBe(10)
})
```

- [ ] **Step 2: Run — expect FAIL**

`pnpm test -- tests/unit/server/middleware/rate-limit.test.ts`

Expected: the existing "verified gets 13" test fails because limit is now 3. New "credits get 10" test fails because the middleware doesn't yet check credits.

- [ ] **Step 3: Update `src/server/middleware/rate-limit.ts`**

Replace the body of `checkRateLimit` to use `getCookieWithUserAndCredits` and a 3-tier branch:

```ts
const WINDOW_MS = 86_400_000
const ANON_LIMIT = 3
const CREDITS_LIMIT = 10

function gradeBucketKey(ip: string, cookie: string): string {
  return `bucket:ip:${ip}+cookie:${cookie}`
}

export async function checkRateLimit(
  redis: Redis,
  store: GradeStore,
  ip: string,
  cookie: string,
  now: number = Date.now(),
): Promise<BucketResult> {
  const row = await store.getCookieWithUserAndCredits(cookie)
  const limit = (row.credits > 0) ? CREDITS_LIMIT : ANON_LIMIT
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  const peek = await peekBucket(redis, cfg, now)
  if (!peek.allowed) return peek
  await addToBucket(redis, cfg, now)
  return { allowed: true, limit, used: peek.used + 1, retryAfter: 0 }
}
```

Note the removal of the `VERIFIED_LIMIT = 13` constant and the simplification: verified-without-credits = anonymous for rate-limit purposes.

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/server/middleware/rate-limit.test.ts`

- [ ] **Step 5: Update the integration test**

In `tests/integration/rate-limit.test.ts`, find the existing "verified cookies (userId set) get limit=13" test and:
- Update the assertion from `limit).toBe(13)` → `limit).toBe(3)`.
- Change the loop from `< 13` to `< 3`.

Add a new case:

```ts
it('credit-holding cookies get limit=10', async () => {
  const redis = createRedis(redisUrl)
  const store = new PostgresStore(testDb.db)
  const user = await store.upsertUser(`rl-credits-${Date.now()}@example.com`)
  const cookie = `credits-${Date.now()}`
  await store.upsertCookie(cookie, user.id)
  await store.createStripePayment({
    gradeId: null as never, sessionId: `cs_rl_${Date.now()}`, amountCents: 2900, currency: 'usd',
  })
  await store.grantCreditsAndMarkPaid(`cs_rl_${Date.now() - 1}` as never, user.id, 10, 2900, 'usd')
  // Above is tricky due to sessionId uniqueness across beforeEach; use a UUID instead:
  const uniqueSession = crypto.randomUUID()
  await store.createStripePayment({
    gradeId: null as never, sessionId: uniqueSession, amountCents: 2900, currency: 'usd',
  })
  await store.grantCreditsAndMarkPaid(uniqueSession, user.id, 10, 2900, 'usd')

  const ip = '203.0.113.102'
  for (let i = 0; i < 10; i++) {
    const r = await checkRateLimit(redis, store, ip, cookie)
    expect(r.allowed).toBe(true)
    expect(r.limit).toBe(10)
  }
  const blocked = await checkRateLimit(redis, store, ip, cookie)
  expect(blocked.allowed).toBe(false)
  await redis.quit()
})
```

(The inline duplicate `createStripePayment` above is a redundant relic — remove the first attempt with the `Date.now()` sessionId, keep only the `crypto.randomUUID()` version.)

- [ ] **Step 6: Run integration — expect PASS**

`pnpm test:integration -- tests/integration/rate-limit.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/server/middleware/rate-limit.ts tests/unit/server/middleware/rate-limit.test.ts \
        tests/integration/rate-limit.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(rate-limit): 3-tier (anon/verified=3, credits=10); drop +10 email bonus"
```

---

## Task 5: `POST /billing/buy-credits` route

**Files:**
- Modify: `src/server/routes/billing.ts`
- Test: `tests/unit/server/routes/billing-buy-credits.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `tests/unit/server/routes/billing-buy-credits.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { Queue } from 'bullmq'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

type AppType = Hono<{ Variables: { cookie: string; clientIp: string } }>

function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe('whsec_test_fake')
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/billing', billingRouter({
    store, billing,
    priceId: 'price_test_report',
    creditsPriceId: 'price_test_credits',
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue: null as unknown as Queue,
  }))
  return { app, store, billing }
}

async function issueCookie(app: AppType): Promise<string> {
  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gradeId: 'not-uuid' }),
  }))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie')
  return raw
}

describe('POST /billing/buy-credits', () => {
  it('happy path: creates Stripe session for verified user + inserts pending row', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie(uuid, user.id)

    const res = await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toMatch(/^https:\/\/fake\.stripe\.test\//)
    expect(billing.createdSessions).toHaveLength(1)
    expect(billing.createdSessions[0]!.priceId).toBe('price_test_credits')

    // Pending row inserted with kind='credits', gradeId null
    const payments = await store.listStripePaymentsByGrade(null as never)
    // FakeStore's listStripePaymentsByGrade may not handle null; instead look up by session
    const session = billing.createdSessions[0]!
    // We don't have a direct "find by kind" method; inspect the fake's map
    const allRows = [...store.stripePaymentsMap.values()]
    const creditsRow = allRows.find((r) => r.kind === 'credits')
    expect(creditsRow).toBeDefined()
    expect(creditsRow!.status).toBe('pending')
    expect(creditsRow!.amountCents).toBe(2900)
  })

  it('409 must_verify_email when cookie is not bound to a user', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)

    const res = await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('must_verify_email')
  })

  it('Stripe checkout metadata includes type=credits + userId + creditCount', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie(uuid, user.id)

    await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    const session = billing.createdSessions[0]!
    // FakeStripe stores metadata in the session response; inspect the sessions map
    const sessionRow = [...billing.sessions.values()].find((s) => s.metadata.gradeId === undefined)
    // Actually FakeStripe's createCheckoutSession sets metadata.gradeId only.
    // The test instead inspects the createdSessions record which is CheckoutSessionInput,
    // which doesn't include metadata type. This assertion requires the billing client
    // to be extended with type/userId metadata — verify via the sessions map or extend FakeStripe.
    // Simplest: assert the session was created for the credits price ID.
    expect(session.priceId).toBe('price_test_credits')
  })

  it('success URL is /?credits=purchased', async () => {
    const { app, store, billing } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie(uuid, user.id)

    await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    const input = billing.createdSessions[0]!
    expect(input.successUrl).toBe('http://localhost:5173/?credits=purchased')
    expect(input.cancelUrl).toBe('http://localhost:5173/?credits=canceled')
  })

  it('503 stripe_credits_not_configured when deps.creditsPriceId is empty', async () => {
    const store = makeFakeStore()
    const billing = new FakeStripe('whsec_test_fake')
    const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
    app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
    app.route('/billing', billingRouter({
      store, billing,
      priceId: 'price_test_report',
      creditsPriceId: '',
      publicBaseUrl: 'http://localhost:5173',
      webhookSecret: 'whsec_test_fake',
      reportQueue: null as unknown as Queue,
    }))
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie(uuid, user.id)

    const res = await app.fetch(new Request('http://test/billing/buy-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(503)
  })
})
```

**NOTE to the implementer:** the 3rd test ("metadata includes type=credits...") is fragile with the current `FakeStripe` shape because `createCheckoutSession` passes through a `CheckoutSessionInput` that doesn't include free-form metadata. Two options: (a) extend `FakeStripe.createdSessions` recording to capture arbitrary metadata (a small upgrade to the fake); (b) collapse the test into asserting the `priceId` was `price_test_credits` (simpler). Pick (b) for this task — extending the fake is out of scope. The `metadata.type='credits'` contract will be verified in Task 6's webhook test (which reads the event body).

- [ ] **Step 2: Run — expect FAIL**

`pnpm test -- tests/unit/server/routes/billing-buy-credits.test.ts`

- [ ] **Step 3: Extend `BillingRouterDeps`**

In `src/server/routes/billing.ts`, add a new field to `BillingRouterDeps`:

```ts
export interface BillingRouterDeps {
  store: GradeStore
  billing: BillingClient
  priceId: string
  creditsPriceId: string     // NEW
  publicBaseUrl: string
  webhookSecret: string
  reportQueue: Queue<ReportJob>
}
```

- [ ] **Step 4: Add the `/buy-credits` route**

Inside `billingRouter(deps)`, AFTER `/checkout` but BEFORE `/webhook`:

```ts
app.post('/buy-credits', async (c) => {
  if (!deps.creditsPriceId) {
    return c.json({ error: 'stripe_credits_not_configured' }, 503)
  }
  const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
  if (!row.userId) {
    return c.json({ error: 'must_verify_email' }, 409)
  }
  const session = await deps.billing.createCheckoutSession({
    gradeId: `credits:${row.userId}`,     // Stripe metadata.gradeId is repurposed: carries the userId for credits sessions
    priceId: deps.creditsPriceId,
    successUrl: `${deps.publicBaseUrl}/?credits=purchased`,
    cancelUrl: `${deps.publicBaseUrl}/?credits=canceled`,
  })
  await deps.store.createStripePayment({
    gradeId: null as never,   // FakeStore and PG both support null now after the Task 2 migration
    sessionId: session.id,
    amountCents: 2900,
    currency: 'usd',
  })
  // Tag the row as kind='credits' — there's no kind arg on createStripePayment today.
  // Simplest: extend createStripePayment to accept optional kind; default 'report'.
  // See Step 5 for the extension.
  return c.json({ url: session.url })
})
```

**Hmm, this reveals a gap:** `createStripePayment` doesn't take a `kind` argument. We need to add one. Update `src/store/types.ts` `createStripePayment` signature:

```ts
createStripePayment(input: {
  gradeId: string | null   // was string; now nullable
  sessionId: string
  amountCents: number
  currency: string
  kind?: 'report' | 'credits'   // NEW; defaults to 'report'
}): Promise<StripePayment>
```

Update `PostgresStore.createStripePayment` and `FakeStore.createStripePayment` to pass `kind` through (default `'report'`).

Use `gradeId: null, kind: 'credits'` in the buy-credits route:

```ts
await deps.store.createStripePayment({
  gradeId: null,
  sessionId: session.id,
  amountCents: 2900,
  currency: 'usd',
  kind: 'credits',
})
```

- [ ] **Step 5: Update `createStripePayment` implementations**

In `src/store/postgres.ts`, update the existing method:

```ts
async createStripePayment(input: {
  gradeId: string | null
  sessionId: string
  amountCents: number
  currency: string
  kind?: 'report' | 'credits'
}): Promise<StripePayment> {
  const [row] = await this.db.insert(schema.stripePayments).values({
    gradeId: input.gradeId,
    sessionId: input.sessionId,
    amountCents: input.amountCents,
    currency: input.currency,
    kind: input.kind ?? 'report',
    status: 'pending',
  }).returning()
  if (!row) throw new Error('createStripePayment returned no row')
  return row
}
```

In `tests/unit/_helpers/fake-store.ts`, same update:

```ts
async createStripePayment(input): Promise<StripePayment> {
  const row: StripePayment = {
    id: crypto.randomUUID(),
    gradeId: input.gradeId,
    sessionId: input.sessionId,
    kind: input.kind ?? 'report',
    status: 'pending',
    amountCents: input.amountCents,
    currency: input.currency,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  stripePaymentsMap.set(input.sessionId, row)
  return row
},
```

(Make sure the `StripePayment` type now includes `kind` — it will automatically after Task 2's schema change since `StripePayment = InferSelectModel<typeof schema.stripePayments>`.)

- [ ] **Step 6: Go back to Step 4's route code** — the `gradeId: null` and `kind: 'credits'` pass cleanly now.

Also: the route used `gradeId: \`credits:${row.userId}\`` as a workaround in the first pass of Step 4; replace it with the real metadata approach. Since `BillingClient.createCheckoutSession` only accepts `gradeId` as metadata today, and Stripe sessions carry arbitrary metadata in production code but not through our narrow interface, extend the interface:

In `src/billing/types.ts`, broaden `CheckoutSessionInput`:

```ts
export interface CheckoutSessionInput {
  gradeId?: string   // NEW: optional for credits purchases
  userId?: string    // NEW: credits purchases identify a user, not a grade
  kind: 'report' | 'credits'   // NEW: explicit discriminator
  successUrl: string
  cancelUrl: string
  priceId: string
}
```

Then update `StripeBillingClient.createCheckoutSession`:

```ts
async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
  const metadata: Record<string, string> = { kind: input.kind }
  if (input.gradeId) metadata.gradeId = input.gradeId
  if (input.userId) metadata.userId = input.userId
  if (input.kind === 'credits') metadata.creditCount = '10'

  const session = await this.stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: input.priceId, quantity: 1 }],
    metadata,
    client_reference_id: input.gradeId ?? input.userId ?? '',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  })
  return this.toSession(session)
}
```

And update `FakeStripe.createCheckoutSession` to match:

```ts
async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
  this.createdSessions.push(input)
  const id = `cs_test_fake_${++this.counter}_${input.gradeId ?? input.userId ?? 'anon'}`
  const session: StoredSession = {
    id,
    url: `https://fake.stripe.test/${id}`,
    status: 'open',
    paymentStatus: 'unpaid',
    amountTotal: null,
    currency: null,
    metadata: {
      kind: input.kind,
      ...(input.gradeId ? { gradeId: input.gradeId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.kind === 'credits' ? { creditCount: '10' } : {}),
    },
    _payment_intent: `pi_test_fake_${this.counter}`,
  }
  this.sessions.set(id, session)
  return session
}
```

Update `CheckoutSession.metadata` type to allow arbitrary fields:

```ts
export interface CheckoutSession {
  id: string
  url: string
  status: 'open' | 'complete' | 'expired'
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required'
  amountTotal: number | null
  currency: string | null
  metadata: { gradeId?: string; userId?: string; kind?: string; creditCount?: string }
}
```

And update the existing `/checkout` route to pass `kind: 'report'`:

```ts
const session = await deps.billing.createCheckoutSession({
  gradeId, kind: 'report',
  priceId: deps.priceId,
  successUrl: `${deps.publicBaseUrl}/g/${gradeId}?checkout=complete`,
  cancelUrl: `${deps.publicBaseUrl}/g/${gradeId}?checkout=canceled`,
})
```

Rewrite the `/buy-credits` route's session call:

```ts
const session = await deps.billing.createCheckoutSession({
  userId: row.userId,
  kind: 'credits',
  priceId: deps.creditsPriceId,
  successUrl: `${deps.publicBaseUrl}/?credits=purchased`,
  cancelUrl: `${deps.publicBaseUrl}/?credits=canceled`,
})
```

- [ ] **Step 7: Fix existing billing-checkout.test.ts — it will fail**

In `tests/unit/server/routes/billing-checkout.test.ts`, the existing test's assertion on `createdSessions[0]!.gradeId` still works because the field is now optional but populated. But if the test builds a `BillingRouterDeps`, add `creditsPriceId: 'price_test_credits'`:

Find all `billingRouter({...})` calls in that file and add `creditsPriceId: 'price_test_credits',` to each.

- [ ] **Step 8: Run all route tests — expect PASS**

```
pnpm test -- tests/unit/server/routes/billing-checkout.test.ts \
             tests/unit/server/routes/billing-buy-credits.test.ts \
             tests/unit/server/routes/billing-webhook.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add src/billing/types.ts src/billing/stripe-client.ts src/server/routes/billing.ts \
        src/store/types.ts src/store/postgres.ts \
        tests/unit/_helpers/fake-stripe.ts tests/unit/_helpers/fake-store.ts \
        tests/unit/server/routes/billing-buy-credits.test.ts \
        tests/unit/server/routes/billing-checkout.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): POST /billing/buy-credits with typed CheckoutSessionInput"
```

---

## Task 6: Webhook branch — credits vs report

**Files:**
- Modify: `src/server/routes/billing.ts`
- Modify: `tests/unit/server/routes/billing-webhook.test.ts`

- [ ] **Step 1: Add failing tests for credits branch**

Append to `tests/unit/server/routes/billing-webhook.test.ts`:

```ts
describe('POST /billing/webhook — credits branch', () => {
  it('happy path: grants credits + marks payment paid', async () => {
    const { app, store, billing } = build()
    const user = await store.upsertUser('buyer@x.com')
    // Simulate a buy-credits flow: session created + pending row inserted
    const session = await billing.createCheckoutSession({
      userId: user.id, kind: 'credits',
      priceId: 'price_test_credits',
      successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: null, sessionId: session.id,
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    billing.completeSession(session.id, 2900, 'usd')

    // Construct a webhook event shaped as Stripe would send for a credits checkout
    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      metadata: { kind: 'credits', userId: user.id, creditCount: '10' },
      amountTotal: 2900, currency: 'usd',
    })

    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)

    // Credits were granted
    expect(await store.getCredits(user.id)).toBe(10)
    // Payment row is now paid + kind=credits
    const row = await store.getStripePaymentBySessionId(session.id)
    expect(row!.status).toBe('paid')
    expect(row!.kind).toBe('credits')
  })

  it('400 on malformed credits metadata (missing userId)', async () => {
    const { app, billing } = build()
    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: 'cs_bad',
      metadata: { kind: 'credits', creditCount: '10' },   // no userId
      amountTotal: 2900, currency: 'usd',
    })
    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(400)
  })

  it('idempotent on duplicate credits webhook', async () => {
    const { app, store, billing } = build()
    const user = await store.upsertUser('buyer@x.com')
    const session = await billing.createCheckoutSession({
      userId: user.id, kind: 'credits',
      priceId: 'price_test_credits',
      successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: null, sessionId: session.id,
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    billing.completeSession(session.id, 2900, 'usd')

    const payload = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      metadata: { kind: 'credits', userId: user.id, creditCount: '10' },
      amountTotal: 2900, currency: 'usd',
    })

    const first = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': payload.signature, 'content-type': 'application/json' },
      body: payload.body,
    }))
    const second = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': payload.signature, 'content-type': 'application/json' },
      body: payload.body,
    }))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // Credits granted only once
    expect(await store.getCredits(user.id)).toBe(10)
  })
})
```

**NOTE:** `FakeStripe.constructEvent` currently only accepts `gradeId` as metadata (from Task 8 spec). Extend its signature to accept arbitrary metadata:

In `tests/unit/_helpers/fake-stripe.ts`:

```ts
constructEvent(input: {
  type: string
  sessionId: string
  metadata?: Record<string, string>   // NEW — replaces the typed gradeId field
  // Legacy-compat:
  gradeId?: string
  amountTotal?: number
  currency?: string
  paymentIntent?: string
}): ConstructedWebhookEvent {
  const metadata = input.metadata ?? (input.gradeId ? { gradeId: input.gradeId } : {})
  const event: WebhookEvent = {
    id: `evt_test_${this.counter++}`,
    type: input.type,
    data: {
      object: {
        id: input.sessionId,
        metadata,
        ...(input.amountTotal !== undefined ? { amount_total: input.amountTotal } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.paymentIntent !== undefined ? { payment_intent: input.paymentIntent } : {}),
      },
    },
  }
  // rest of the method stays the same: sign body, return { body, signature }
  const body = JSON.stringify(event)
  const ts = Math.floor(Date.now() / 1000)
  const signedPayload = `${ts}.${body}`
  const sig = createHmac('sha256', this.webhookSecret).update(signedPayload).digest('hex')
  return { body, signature: `t=${ts},v1=${sig}` }
}
```

- [ ] **Step 2: Run — expect FAIL**

`pnpm test -- tests/unit/server/routes/billing-webhook.test.ts`

- [ ] **Step 3: Extend the webhook handler**

In `src/server/routes/billing.ts`, find the existing `POST /webhook` handler. After the signature-verify + status-check + idempotency guard, ADD a branch on `metadata.kind`.

Replace the section starting at "// extract gradeId / handle event" with:

```ts
if (event.type !== 'checkout.session.completed') {
  return c.body(null, 200)
}

const sessionId = event.data.object.id
const metadata = event.data.object.metadata ?? {}
const row = await deps.store.getStripePaymentBySessionId(sessionId)
if (!row) return c.json({ error: 'unknown_session' }, 400)
if (row.status === 'paid') {
  return c.body(null, 200)   // idempotent
}

// Branch on row.kind (our source of truth, since metadata is untrusted).
const amountCents = event.data.object.amount_total
const currency = event.data.object.currency

if (row.kind === 'credits') {
  const userId = metadata.userId
  const creditCount = Number(metadata.creditCount ?? 0)
  if (!userId || !Number.isInteger(creditCount) || creditCount < 1) {
    return c.json({ error: 'malformed_credits_metadata' }, 400)
  }
  await deps.store.grantCreditsAndMarkPaid(
    sessionId, userId, creditCount,
    typeof amountCents === 'number' ? amountCents : row.amountCents,
    typeof currency === 'string' ? currency : row.currency,
  )
  return c.body(null, 200)
}

// Default: report kind — existing flow
const gradeId = metadata.gradeId
if (!gradeId || !UUID_REGEX.test(gradeId)) {
  return c.json({ error: 'missing_grade_id' }, 400)
}
if (row.status !== 'paid') {
  await deps.store.updateStripePaymentStatus(sessionId, {
    status: 'paid',
    ...(typeof amountCents === 'number' ? { amountCents } : {}),
    ...(typeof currency === 'string' ? { currency } : {}),
  })
}
await deps.reportQueue.add(
  'generate-report',
  { gradeId, sessionId },
  { jobId: `generate-report-${sessionId}`, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
)
return c.body(null, 200)
```

Note the branch uses `row.kind` (the DB value we inserted at /buy-credits or /checkout time) as the source of truth. `metadata.kind` is informational but not trusted — a forged webhook could lie about kind, but our DB row knows.

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/server/routes/billing-webhook.test.ts`
Expected: 9 total tests (6 existing + 3 new) all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/billing.ts tests/unit/server/routes/billing-webhook.test.ts \
        tests/unit/_helpers/fake-stripe.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): webhook branches on stripe_payments.kind (credits vs report)"
```

---

## Task 7: `POST /billing/redeem-credit` route

**Files:**
- Modify: `src/server/routes/billing.ts`
- Test: `tests/unit/server/routes/billing-redeem-credit.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `tests/unit/server/routes/billing-redeem-credit.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { Queue } from 'bullmq'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'
type AppType = Hono<{ Variables: { cookie: string; clientIp: string } }>

function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe('whsec_test_fake')
  const fakeAdd = vi.fn().mockResolvedValue(undefined)
  const reportQueue = { add: fakeAdd } as unknown as Queue
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/billing', billingRouter({
    store, billing,
    priceId: 'price_test_report',
    creditsPriceId: 'price_test_credits',
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue,
  }))
  return { app, store, billing, fakeAdd }
}

async function issueCookie(app: AppType): Promise<string> {
  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gradeId: 'not-uuid' }),
  }))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie')
  return raw
}

async function seedVerifiedUserWithCredits(app: AppType, store: ReturnType<typeof makeFakeStore>, credits: number) {
  const cookie = await issueCookie(app)
  const uuid = cookie.split('.')[0]!
  const user = await store.upsertUser('u@x.com')
  await store.upsertCookie(uuid, user.id)
  if (credits > 0) {
    await store.createStripePayment({
      gradeId: null, sessionId: `cs_seed_${user.id}`,
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid(`cs_seed_${user.id}`, user.id, credits, 2900, 'usd')
  }
  return { cookie, uuid, user }
}

describe('POST /billing/redeem-credit', () => {
  it('happy path: decrements credits, writes audit row, enqueues generate-report', async () => {
    const { app, store, fakeAdd } = build()
    const { cookie, uuid, user } = await seedVerifiedUserWithCredits(app, store, 5)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })

    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(204)
    expect(await store.getCredits(user.id)).toBe(4)

    // Audit row inserted
    const payments = await store.listStripePaymentsByGrade(grade.id)
    const creditRow = payments.find((p) => p.kind === 'credits')
    expect(creditRow).toBeDefined()
    expect(creditRow!.status).toBe('paid')
    expect(creditRow!.amountCents).toBe(0)

    // Job enqueued
    expect(fakeAdd).toHaveBeenCalledWith(
      'generate-report',
      { gradeId: grade.id, sessionId: expect.stringContaining('credit:') },
      expect.objectContaining({ jobId: expect.stringContaining('credit:') }),
    )
  })

  it('404 on non-owned grade', async () => {
    const { app, store } = build()
    const { cookie } = await seedVerifiedUserWithCredits(app, store, 5)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: 'other', status: 'done',
    })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(404)
  })

  it('409 grade_not_done', async () => {
    const { app, store } = build()
    const { cookie, uuid } = await seedVerifiedUserWithCredits(app, store, 5)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'running',
    })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('grade_not_done')
  })

  it('409 must_verify_email when cookie is not bound', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('must_verify_email')
  })

  it('409 no_credits when balance is 0', async () => {
    const { app, store } = build()
    const { cookie, uuid } = await seedVerifiedUserWithCredits(app, store, 0)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('no_credits')
  })

  it('409 already_paid when a prior Stripe payment exists for the grade', async () => {
    const { app, store } = build()
    const { cookie, uuid, user } = await seedVerifiedUserWithCredits(app, store, 5)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })
    // Simulate a prior $19 checkout that was paid
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_prior', amountCents: 1900, currency: 'usd',
    })
    await store.updateStripePaymentStatus('cs_prior', { status: 'paid' })
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('already_paid')
    // Credits NOT spent
    expect(await store.getCredits(user.id)).toBe(5)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

`pnpm test -- tests/unit/server/routes/billing-redeem-credit.test.ts`

- [ ] **Step 3: Add the route**

In `src/server/routes/billing.ts`, AFTER `/buy-credits` and BEFORE `/webhook`, add:

```ts
app.post(
  '/redeem-credit',
  zValidator('json', checkoutSchema, (result, c) => {
    if (!result.success) return c.json({ error: 'invalid_body' }, 400)
  }),
  async (c) => {
    const { gradeId } = c.req.valid('json')
    const grade = await deps.store.getGrade(gradeId)
    if (!grade) return c.json({ error: 'not_found' }, 404)
    if (grade.cookie !== c.var.cookie) return c.json({ error: 'not_found' }, 404)
    if (grade.status !== 'done') return c.json({ error: 'grade_not_done' }, 409)

    // Already paid (either via $19 or prior credit)?
    const payments = await deps.store.listStripePaymentsByGrade(gradeId)
    if (payments.some((p) => p.status === 'paid')) {
      return c.json({ error: 'already_paid', reportId: grade.id }, 409)
    }

    const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
    if (!row.userId) return c.json({ error: 'must_verify_email' }, 409)

    // Atomic decrement via the store method (WHERE credits > 0 serialization)
    const redeem = await deps.store.redeemCredit(row.userId)
    if (!redeem.ok) return c.json({ error: 'no_credits' }, 409)

    // Audit row — tag the grade as paid-by-credit
    const auditSessionId = `credit:${gradeId}`
    await deps.store.createStripePayment({
      gradeId, sessionId: auditSessionId, amountCents: 0, currency: 'usd', kind: 'credits',
    })
    await deps.store.updateStripePaymentStatus(auditSessionId, { status: 'paid' })

    // Enqueue the same generate-report job the $19 flow uses
    await deps.reportQueue.add(
      'generate-report',
      { gradeId, sessionId: auditSessionId },
      { jobId: `generate-report-${auditSessionId}`, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
    )

    return c.body(null, 204)
  },
)
```

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/server/routes/billing-redeem-credit.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Full validation + commit**

`pnpm test` clean.

```bash
git add src/server/routes/billing.ts tests/unit/server/routes/billing-redeem-credit.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): POST /billing/redeem-credit with atomic decrement + audit"
```

---

## Task 8: Wire `creditsPriceId` through app.ts + server.ts

**Files:**
- Modify: `src/server/deps.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/server.ts`
- Modify: all test files that construct `ServerDeps` (fallout)

- [ ] **Step 1: Extend `ServerDeps.env`**

In `src/server/deps.ts`:

```ts
env: {
  NODE_ENV: 'development' | 'test' | 'production'
  COOKIE_HMAC_KEY: string
  PUBLIC_BASE_URL: string
  STRIPE_PRICE_ID: string | null
  STRIPE_WEBHOOK_SECRET: string | null
  STRIPE_CREDITS_PRICE_ID: string | null   // NEW
}
```

- [ ] **Step 2: Pass `creditsPriceId` through `buildApp`**

In `src/server/app.ts`, find the `billingScope.route('/', billingRouter({...}))` call and add the new field:

```ts
if (deps.billing && deps.env.STRIPE_PRICE_ID && deps.env.STRIPE_WEBHOOK_SECRET) {
  const billing = deps.billing
  const priceId = deps.env.STRIPE_PRICE_ID
  const creditsPriceId = deps.env.STRIPE_CREDITS_PRICE_ID ?? ''   // NEW
  const webhookSecret = deps.env.STRIPE_WEBHOOK_SECRET
  const billingScope = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  billingScope.use('/checkout', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  billingScope.use('/buy-credits', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  billingScope.use('/redeem-credit', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
  billingScope.route('/', billingRouter({
    store: deps.store, billing, priceId, creditsPriceId,
    publicBaseUrl: deps.env.PUBLIC_BASE_URL,
    webhookSecret, reportQueue: deps.reportQueue,
  }))
  app.route('/billing', billingScope)
} else {
  // 503 fallbacks stay the same, plus add the two new endpoints:
  app.post('/billing/checkout', (c) => c.json({ error: 'stripe_not_configured' }, 503))
  app.post('/billing/buy-credits', (c) => c.json({ error: 'stripe_not_configured' }, 503))
  app.post('/billing/redeem-credit', (c) => c.json({ error: 'stripe_not_configured' }, 503))
  app.post('/billing/webhook', (c) => c.json({ error: 'stripe_not_configured' }, 503))
  // existing warn-once log stays
}
```

- [ ] **Step 3: Pass env through in `src/server/server.ts`**

Find the `buildApp({...env: {...}})` block and add:

```ts
env: {
  NODE_ENV: env.NODE_ENV,
  COOKIE_HMAC_KEY: cookieHmacKey,
  PUBLIC_BASE_URL: publicBaseUrl,
  STRIPE_PRICE_ID: env.STRIPE_PRICE_ID ?? null,
  STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET ?? null,
  STRIPE_CREDITS_PRICE_ID: env.STRIPE_CREDITS_PRICE_ID ?? null,   // NEW
},
```

- [ ] **Step 4: Fix fallout — every test constructing `ServerDeps`**

Run `pnpm typecheck` to find all fallout. Add `STRIPE_CREDITS_PRICE_ID: null` to each `env` block. Known-broken from prior plans:

- `tests/unit/server/healthz.test.ts`
- `tests/unit/server/routes/grades.test.ts`
- `tests/unit/server/routes/grades-events.test.ts`
- `tests/integration/healthz.test.ts`
- `tests/integration/grades-events-live-full-run.test.ts`
- `tests/integration/grades-events-live-reconnect.test.ts`
- `tests/integration/grades-events-report-hydration.test.ts`
- `tests/integration/auth-magic-link.test.ts`
- `tests/integration/auth-rate-limit.test.ts`
- `tests/integration/auth-token-failures.test.ts`
- `tests/integration/billing-webhook.test.ts`
- `tests/integration/generate-report-lifecycle.test.ts`

Each gets `STRIPE_CREDITS_PRICE_ID: null` appended to the env literal.

- [ ] **Step 5: Full validation**

`pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm build` all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/deps.ts src/server/app.ts src/server/server.ts \
        $(git ls-files -m tests/)
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): wire creditsPriceId through app + env"
```

---

## Task 9: `/auth/me` + useAuth extension

**Files:**
- Modify: `src/server/routes/auth.ts` — `/auth/me` returns credits
- Modify: `src/web/lib/api.ts` — `getAuthMe` return type
- Modify: `src/web/hooks/useAuth.ts` — expose credits
- Modify: `tests/unit/server/routes/auth-logout-me.test.ts` — assert credits in response
- Modify: `tests/unit/web/hooks/useAuth.test.tsx` — assert credits field

- [ ] **Step 1: Update `/auth/me` on server side**

In `src/server/routes/auth.ts`, find the `app.get('/me', ...)` handler. Change it to use `getCookieWithUserAndCredits`:

```ts
app.get('/me', async (c) => {
  const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
  if (row.userId && row.email) {
    return c.json({ verified: true, email: row.email, credits: row.credits })
  }
  return c.json({ verified: false })
})
```

- [ ] **Step 2: Update the auth-logout-me test**

In `tests/unit/server/routes/auth-logout-me.test.ts`, find the test "returns verified:true + email after verify" and change its assertion:

```ts
expect(await res.json()).toEqual({ verified: true, email: 'user@example.com', credits: 0 })
```

And after-verify the test should also grant some credits and assert they surface. Add a new test:

```ts
it('returns credits when user has them', async () => {
  const { app, store, mailer } = build()
  const cookie = await issueCookie(app)
  await verifyForUser(app, mailer, cookie, 'user@example.com')
  // Grant credits directly via the store
  const user = [...store.usersMap.values()].find((u) => u.email === 'user@example.com')!
  await store.createStripePayment({
    gradeId: null, sessionId: 'cs_me', amountCents: 2900, currency: 'usd', kind: 'credits',
  })
  await store.grantCreditsAndMarkPaid('cs_me', user.id, 7, 2900, 'usd')

  const res = await app.fetch(new Request('http://test/auth/me', {
    headers: { cookie: `ggcookie=${cookie}` },
  }))
  expect(await res.json()).toEqual({ verified: true, email: 'user@example.com', credits: 7 })
})
```

- [ ] **Step 3: Run — expect FAIL**

`pnpm test -- tests/unit/server/routes/auth-logout-me.test.ts`

- [ ] **Step 4: Verify test passes**

After the Step 1 change, the updated assertion + new test should pass.

`pnpm test -- tests/unit/server/routes/auth-logout-me.test.ts`

- [ ] **Step 5: Update `getAuthMe` client + `useAuth`**

In `src/web/lib/api.ts`:

```ts
export async function getAuthMe(): Promise<{ verified: boolean; email?: string; credits?: number }> {
  const res = await fetch('/auth/me', { credentials: 'include' })
  if (!res.ok) return { verified: false }
  return res.json() as Promise<{ verified: boolean; email?: string; credits?: number }>
}
```

In `src/web/hooks/useAuth.ts`:

```ts
export interface AuthState {
  verified: boolean
  email: string | null
  credits: number   // NEW
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

export function useAuth(): AuthState {
  const [verified, setVerified] = useState<boolean>(false)
  const [email, setEmail] = useState<string | null>(null)
  const [credits, setCredits] = useState<number>(0)

  const refresh = useCallback(async () => {
    const me = await getAuthMe()
    setVerified(me.verified)
    setEmail(me.email ?? null)
    setCredits(me.credits ?? 0)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const logout = useCallback(async () => {
    await postAuthLogout()
    await refresh()
  }, [refresh])

  return { verified, email, credits, refresh, logout }
}
```

- [ ] **Step 6: Update useAuth unit test**

In `tests/unit/web/hooks/useAuth.test.tsx`, the first test's mock returns `{ verified: true, email: 'u@ex.com' }`. Update that to include credits, and add a new test asserting credits surface:

```ts
it('starts unverified; refresh() pulls from /auth/me with credits', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true, email: 'u@ex.com', credits: 7 }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const { result } = renderHook(() => useAuth())
  await waitFor(() => expect(result.current.verified).toBe(true))
  expect(result.current.email).toBe('u@ex.com')
  expect(result.current.credits).toBe(7)
})
```

- [ ] **Step 7: Run — expect PASS**

`pnpm test -- tests/unit/web/hooks/useAuth.test.tsx`

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/auth.ts src/web/lib/api.ts src/web/hooks/useAuth.ts \
        tests/unit/server/routes/auth-logout-me.test.ts tests/unit/web/hooks/useAuth.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): expose credits balance via /auth/me + useAuth"
```

---

## Task 10: Frontend — BuyReportButton credit branch + api helpers

**Files:**
- Modify: `src/web/lib/api.ts` — add postBillingBuyCredits + postBillingRedeemCredit
- Modify: `src/web/components/BuyReportButton.tsx`
- Modify: `tests/unit/web/components/BuyReportButton.test.tsx`

- [ ] **Step 1: Add API helpers**

Append to `src/web/lib/api.ts`:

```ts
export async function postBillingBuyCredits(): Promise<{ ok: true; url: string } | { ok: false; kind: 'must_verify_email' | 'unavailable' | 'unknown'; status?: number }> {
  let res: Response
  try {
    res = await fetch('/billing/buy-credits', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }
  if (res.status === 200) {
    const body = await res.json() as { url: string }
    return { ok: true, url: body.url }
  }
  if (res.status === 409) return { ok: false, kind: 'must_verify_email' }
  if (res.status === 503) return { ok: false, kind: 'unavailable' }
  return { ok: false, kind: 'unknown', status: res.status }
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; kind: 'already_paid' | 'grade_not_done' | 'no_credits' | 'must_verify_email' | 'unavailable' | 'unknown'; status?: number }

export async function postBillingRedeemCredit(gradeId: string): Promise<RedeemResult> {
  let res: Response
  try {
    res = await fetch('/billing/redeem-credit', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gradeId }),
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }
  if (res.status === 204) return { ok: true }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error === 'already_paid') return { ok: false, kind: 'already_paid' }
    if (body.error === 'grade_not_done') return { ok: false, kind: 'grade_not_done' }
    if (body.error === 'no_credits') return { ok: false, kind: 'no_credits' }
    if (body.error === 'must_verify_email') return { ok: false, kind: 'must_verify_email' }
    return { ok: false, kind: 'unknown', status: res.status }
  }
  if (res.status === 503) return { ok: false, kind: 'unavailable' }
  return { ok: false, kind: 'unknown', status: res.status }
}
```

- [ ] **Step 2: Write failing tests for BuyReportButton**

Append to `tests/unit/web/components/BuyReportButton.test.tsx`:

```ts
describe('BuyReportButton — credits branch', () => {
  it('shows "Redeem 1 credit" label when credits > 0', () => {
    // Mock useAuth to return credits=5
    vi.doMock('../../../../src/web/hooks/useAuth.ts', () => ({
      useAuth: () => ({ verified: true, email: 'u@ex.com', credits: 5, refresh: async () => {}, logout: async () => {} }),
    }))
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    expect(screen.getByRole('button', { name: /redeem 1 credit \(4 left\)/i })).toBeInTheDocument()
  })

  it('shows "$19" label when credits === 0', () => {
    vi.doMock('../../../../src/web/hooks/useAuth.ts', () => ({
      useAuth: () => ({ verified: true, email: 'u@ex.com', credits: 0, refresh: async () => {}, logout: async () => {} }),
    }))
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    expect(screen.getByRole('button', { name: /full report — \$19/i })).toBeInTheDocument()
  })

  it('clicking redeem calls postBillingRedeemCredit; does not redirect', async () => {
    vi.doMock('../../../../src/web/hooks/useAuth.ts', () => ({
      useAuth: () => ({ verified: true, email: 'u@ex.com', credits: 3, refresh: async () => {}, logout: async () => {} }),
    }))
    vi.spyOn(api, 'postBillingRedeemCredit').mockResolvedValue({ ok: true })
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock, href: '' })
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    await user.click(screen.getByRole('button', { name: /redeem/i }))
    expect(api.postBillingRedeemCredit).toHaveBeenCalledWith('g-1')
    expect(assignMock).not.toHaveBeenCalled()
  })

  it('shows no_credits error after failed redeem', async () => {
    vi.doMock('../../../../src/web/hooks/useAuth.ts', () => ({
      useAuth: () => ({ verified: true, email: 'u@ex.com', credits: 1, refresh: async () => {}, logout: async () => {} }),
    }))
    vi.spyOn(api, 'postBillingRedeemCredit').mockResolvedValue({ ok: false, kind: 'no_credits' })
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    await user.click(screen.getByRole('button', { name: /redeem/i }))
    expect(await screen.findByText(/no credits available/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

`pnpm test -- tests/unit/web/components/BuyReportButton.test.tsx`

- [ ] **Step 4: Update `BuyReportButton.tsx`**

```tsx
import React, { useState } from 'react'
import { postBillingCheckout, postBillingRedeemCredit } from '../lib/api.ts'
import { useAuth } from '../hooks/useAuth.ts'

interface BuyReportButtonProps {
  gradeId: string
  onAlreadyPaid: (reportId: string) => void
}

export function BuyReportButton({ gradeId, onAlreadyPaid }: BuyReportButtonProps): JSX.Element {
  const { credits, refresh } = useAuth()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasCredits = credits > 0

  async function handleClick(): Promise<void> {
    setPending(true); setError(null)
    if (hasCredits) {
      const result = await postBillingRedeemCredit(gradeId)
      setPending(false)
      if (result.ok) {
        await refresh()   // pull updated credit balance
        return
      }
      if (result.kind === 'already_paid') { onAlreadyPaid(gradeId); return }
      if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
      if (result.kind === 'no_credits') { setError('No credits available. Buy a pack below.'); return }
      if (result.kind === 'must_verify_email') { setError('Verify your email first.'); return }
      if (result.kind === 'unavailable') { setError('Checkout is temporarily unavailable.'); return }
      setError('Something went wrong. Try again?')
      return
    }
    // No credits: fall through to the $19 Stripe flow
    const result = await postBillingCheckout(gradeId)
    if (result.ok) { window.location.assign(result.url); return }
    setPending(false)
    if (result.kind === 'already_paid') { onAlreadyPaid(result.reportId); return }
    if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
    if (result.kind === 'unavailable') { setError('Checkout is temporarily unavailable.'); return }
    setError('Something went wrong. Try again?')
  }

  const label = hasCredits
    ? `Redeem 1 credit (${credits - 1} left)`
    : 'Get the full report — $19'

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
        {pending ? '...' : label}
      </button>
      {error !== null && <div className="text-xs text-[var(--color-warn)] mt-2">{error}</div>}
    </div>
  )
}
```

- [ ] **Step 5: Run — expect PASS**

`pnpm test -- tests/unit/web/components/BuyReportButton.test.tsx`

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/api.ts src/web/components/BuyReportButton.tsx \
        tests/unit/web/components/BuyReportButton.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): BuyReportButton branches on credit balance"
```

---

## Task 11: Frontend — CreditBadge + Header integration

**Files:**
- Create: `src/web/components/CreditBadge.tsx`
- Modify: `src/web/components/Header.tsx`
- Test: `tests/unit/web/components/CreditBadge.test.tsx` (new)
- Modify: `tests/unit/web/components/Header.test.tsx`

- [ ] **Step 1: Write `CreditBadge.tsx`**

```tsx
import React from 'react'

interface CreditBadgeProps {
  credits: number
}

export function CreditBadge({ credits }: CreditBadgeProps): JSX.Element {
  return (
    <span
      data-testid="credit-badge"
      title={`${credits} credit${credits === 1 ? '' : 's'} available`}
      className="bg-[var(--color-good)] text-[var(--color-bg)] px-2 py-0.5 text-xs rounded font-semibold"
    >
      {credits} {credits === 1 ? 'credit' : 'credits'}
    </span>
  )
}
```

- [ ] **Step 2: Write CreditBadge test**

Create `tests/unit/web/components/CreditBadge.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CreditBadge } from '../../../../src/web/components/CreditBadge.tsx'

afterEach(() => cleanup())

describe('CreditBadge', () => {
  it('renders the count with pluralization', () => {
    render(<CreditBadge credits={7} />)
    expect(screen.getByText('7 credits')).toBeInTheDocument()
  })

  it('renders singular for count=1', () => {
    render(<CreditBadge credits={1} />)
    expect(screen.getByText('1 credit')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run — expect PASS** (after creating the component)

`pnpm test -- tests/unit/web/components/CreditBadge.test.tsx`

- [ ] **Step 4: Add CreditBadge to Header conditionally**

In `src/web/components/Header.tsx`:

```tsx
import React from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.ts'
import { CreditBadge } from './CreditBadge.tsx'

export function Header(): JSX.Element {
  const { verified, credits, logout } = useAuth()
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-bg-sidebar)] px-4 py-2 text-xs flex items-center justify-between">
      <Link to="/" className="text-[var(--color-brand)]">geo-reporter</Link>
      <div className="flex items-center gap-3">
        {verified && credits > 0 && <CreditBadge credits={credits} />}
        {verified && (
          <button
            type="button"
            onClick={() => void logout()}
            className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            sign out
          </button>
        )}
      </div>
    </header>
  )
}
```

- [ ] **Step 5: Update Header test**

In `tests/unit/web/components/Header.test.tsx`, update the existing mocks to include `credits` and add a new test:

```ts
it('shows credit badge when verified and credits > 0', () => {
  mockAuth.current = { verified: true, email: 'u@e.com', credits: 7, refresh: async () => {}, logout: vi.fn() }
  render(<MemoryRouter><Header /></MemoryRouter>)
  expect(screen.getByTestId('credit-badge')).toHaveTextContent('7 credits')
})

it('hides credit badge when credits === 0', () => {
  mockAuth.current = { verified: true, email: 'u@e.com', credits: 0, refresh: async () => {}, logout: vi.fn() }
  render(<MemoryRouter><Header /></MemoryRouter>)
  expect(screen.queryByTestId('credit-badge')).toBeNull()
})
```

And update any existing test's `mockAuth.current` assignments to include `credits: 0` (default).

- [ ] **Step 6: Run — expect PASS**

`pnpm test -- tests/unit/web/components/Header.test.tsx`

- [ ] **Step 7: Commit**

```bash
git add src/web/components/CreditBadge.tsx src/web/components/Header.tsx \
        tests/unit/web/components/CreditBadge.test.tsx tests/unit/web/components/Header.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): CreditBadge + Header conditional display"
```

---

## Task 12: Frontend — BuyCreditsCTA + LandingPage toast + LiveGradePage integration

**Files:**
- Create: `src/web/components/BuyCreditsCTA.tsx`
- Create: `src/web/components/CreditsPurchasedToast.tsx`
- Modify: `src/web/pages/LandingPage.tsx` — render BuyCreditsCTA + handle ?credits params
- Modify: `src/web/pages/LiveGradePage.tsx` — render BuyCreditsCTA in PaidReportStatus success state
- Test: `tests/unit/web/components/BuyCreditsCTA.test.tsx` (new)
- Modify: `tests/unit/web/pages/LandingPage.test.tsx` — add credits param tests

- [ ] **Step 1: Write `BuyCreditsCTA.tsx`**

```tsx
import React, { useState } from 'react'
import { postBillingBuyCredits } from '../lib/api.ts'

export function BuyCreditsCTA(): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick(): Promise<void> {
    setPending(true); setError(null)
    const result = await postBillingBuyCredits()
    if (result.ok) {
      window.location.assign(result.url)
      return
    }
    setPending(false)
    if (result.kind === 'must_verify_email') { setError('Verify your email first.'); return }
    if (result.kind === 'unavailable') { setError('Unavailable right now.'); return }
    setError('Something went wrong. Try again?')
  }

  return (
    <div className="mt-6 border border-[var(--color-good)] p-4">
      <div className="text-sm text-[var(--color-fg)] mb-1 font-semibold">
        💎 Save 85% — 10 reports for $29
      </div>
      <div className="text-xs text-[var(--color-fg-muted)] mb-3">
        Credits never expire. Full 4-provider reports, same as the one-off.
      </div>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={pending}
        className="bg-[var(--color-good)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
      >
        {pending ? '...' : 'Get credits'}
      </button>
      {error !== null && <div className="text-xs text-[var(--color-warn)] mt-2">{error}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Write `CreditsPurchasedToast.tsx`**

```tsx
import React from 'react'
import { Toast } from './Toast.tsx'

interface CreditsPurchasedToastProps {
  kind: 'purchased' | 'canceled'
  onDismiss: () => void
}

export function CreditsPurchasedToast({ kind, onDismiss }: CreditsPurchasedToastProps): JSX.Element {
  const message = kind === 'purchased'
    ? '🎉 10 credits added.'
    : 'Checkout canceled — no charge.'
  return <Toast message={message} onDismiss={onDismiss} />
}
```

- [ ] **Step 3: Write BuyCreditsCTA test**

Create `tests/unit/web/components/BuyCreditsCTA.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuyCreditsCTA } from '../../../../src/web/components/BuyCreditsCTA.tsx'
import * as api from '../../../../src/web/lib/api.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('BuyCreditsCTA', () => {
  it('clicking redirects to the Stripe URL', async () => {
    vi.spyOn(api, 'postBillingBuyCredits').mockResolvedValue({ ok: true, url: 'https://stripe.test/credits' })
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock, href: '' })
    const user = userEvent.setup()
    render(<BuyCreditsCTA />)
    await user.click(screen.getByRole('button', { name: /get credits/i }))
    expect(assignMock).toHaveBeenCalledWith('https://stripe.test/credits')
  })

  it('shows must_verify_email error', async () => {
    vi.spyOn(api, 'postBillingBuyCredits').mockResolvedValue({ ok: false, kind: 'must_verify_email' })
    const user = userEvent.setup()
    render(<BuyCreditsCTA />)
    await user.click(screen.getByRole('button', { name: /get credits/i }))
    expect(await screen.findByText(/verify your email/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run — expect PASS**

`pnpm test -- tests/unit/web/components/BuyCreditsCTA.test.tsx`

- [ ] **Step 5: Integrate into LandingPage**

In `src/web/pages/LandingPage.tsx`, extend the URL-param handling to include `credits` + render `BuyCreditsCTA` for signed-in users:

```tsx
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCreateGrade } from '../hooks/useCreateGrade.ts'
import { useAuth } from '../hooks/useAuth.ts'
import { UrlForm } from '../components/UrlForm.tsx'
import { Toast } from '../components/Toast.tsx'
import { BuyCreditsCTA } from '../components/BuyCreditsCTA.tsx'
import { CreditsPurchasedToast } from '../components/CreditsPurchasedToast.tsx'

export function LandingPage(): JSX.Element {
  const { create, pending, error } = useCreateGrade()
  const { verified, refresh } = useAuth()
  const [params, setParams] = useSearchParams()
  const [verifiedToast, setVerifiedToast] = useState<boolean>(params.get('verified') === '1')
  const [authError] = useState<string | null>(params.get('auth_error'))
  const [creditsToast, setCreditsToast] = useState<'purchased' | 'canceled' | null>(
    params.get('credits') === 'purchased' ? 'purchased' :
    params.get('credits') === 'canceled' ? 'canceled' :
    null
  )

  useEffect(() => {
    const any = ['verified', 'auth_error', 'credits'].some((k) => params.get(k) !== null)
    if (any) {
      const next = new URLSearchParams(params)
      next.delete('verified')
      next.delete('auth_error')
      next.delete('credits')
      setParams(next, { replace: true })
    }
    // If credits just got purchased, refresh useAuth so the badge updates immediately
    if (params.get('credits') === 'purchased') void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">landing</div>
      <h1 className="text-3xl mt-2 mb-2 text-[var(--color-fg)]">How well do LLMs know your site?</h1>
      <p className="text-[var(--color-fg-dim)] mb-8">
        We scrape your page, ask four LLMs about you, and score the results across six categories.
      </p>

      {authError !== null && (
        <div className="bg-[var(--color-bg-elevated)] border border-[var(--color-brand)] text-[var(--color-fg)] px-4 py-3 mb-6 flex items-center justify-between">
          <span>Your sign-in link didn't work or expired.</span>
          <a href="/email" className="text-[var(--color-brand)] underline text-sm">Request a new link →</a>
        </div>
      )}

      <UrlForm
        onSubmit={(url) => { void create(url) }}
        pending={pending}
        {...(error !== null ? { errorMessage: error } : {})}
      />

      {verified && <BuyCreditsCTA />}

      {verifiedToast && (
        <Toast
          message="You're in — 3 grades per 24 hours. Credits unlock more."
          onDismiss={() => setVerifiedToast(false)}
        />
      )}
      {creditsToast !== null && (
        <CreditsPurchasedToast kind={creditsToast} onDismiss={() => setCreditsToast(null)} />
      )}
    </div>
  )
}
```

Note the updated verified toast copy reflects the dropped +10 bonus.

- [ ] **Step 6: Update LandingPage test**

Append to `tests/unit/web/pages/LandingPage.test.tsx`:

```ts
describe('LandingPage — credits URL params', () => {
  it('renders purchased toast when ?credits=purchased', async () => {
    render(
      <MemoryRouter initialEntries={['/?credits=purchased']}>
        <LandingPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/10 credits added/i)).toBeInTheDocument()
  })

  it('renders canceled toast when ?credits=canceled', async () => {
    render(
      <MemoryRouter initialEntries={['/?credits=canceled']}>
        <LandingPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/checkout canceled/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: Integrate BuyCreditsCTA into LiveGradePage success state**

In `src/web/pages/LiveGradePage.tsx`, find where `PaidReportStatus` renders and add a `BuyCreditsCTA` after it when `paidStatus === 'ready'`:

```tsx
{effectivePaidStatus !== 'none' && (
  <>
    <PaidReportStatus
      status={effectivePaidStatus as Exclude<PaidStatus, 'none'>}
      reportId={state.reportId}
      reportToken={state.reportToken}
      error={state.error}
    />
    {effectivePaidStatus === 'ready' && <BuyCreditsCTA />}
  </>
)}
```

Add the import:

```tsx
import { BuyCreditsCTA } from '../components/BuyCreditsCTA.tsx'
```

- [ ] **Step 8: Run all web tests**

`pnpm test -- tests/unit/web/`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/web/components/BuyCreditsCTA.tsx src/web/components/CreditsPurchasedToast.tsx \
        src/web/pages/LandingPage.tsx src/web/pages/LiveGradePage.tsx \
        tests/unit/web/components/BuyCreditsCTA.test.tsx \
        tests/unit/web/pages/LandingPage.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): BuyCreditsCTA + credits toasts on LandingPage + LiveGradePage"
```

---

## Task 13: Integration tests — buy-credits + redeem-credit end-to-end

**Files:**
- Create: `tests/integration/billing-buy-credits.test.ts`
- Create: `tests/integration/billing-redeem-credit.test.ts`

- [ ] **Step 1: Write `billing-buy-credits.test.ts`**

Uses the testcontainers pattern from `tests/integration/billing-webhook.test.ts`. One test case: construct a signed credits-event → POST /billing/webhook → assert `users.credits` updated + `stripe_payments.status='paid'` + `.kind='credits'`.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { sql } from 'drizzle-orm'
import type Redis from 'ioredis'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { buildApp } from '../../src/server/app.ts'
import { getReportQueue } from '../../src/queue/queues.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { FakeStripe } from '../unit/_helpers/fake-stripe.ts'
import { startTestDb, type TestDb } from './setup.ts'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb
let redis: Redis
let billing: FakeStripe

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  testDb = await startTestDb()
}, 120_000)

afterAll(async () => {
  await redis?.quit()
  await testDb.stop()
  await redisContainer.stop()
})

beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, cookies, users, magic_tokens CASCADE`)
  if (redis) await redis.quit()
  redis = createRedis(redisUrl)
  await redis.flushall()
  billing = new FakeStripe('whsec_test_fake')
})

function buildHarness() {
  return buildApp({
    store: new PostgresStore(testDb.db),
    redis,
    redisFactory: () => createRedis(redisUrl),
    mailer: new FakeMailer(),
    billing,
    reportQueue: getReportQueue(redis),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: {
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      STRIPE_PRICE_ID: 'price_test_report',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
      STRIPE_CREDITS_PRICE_ID: 'price_test_credits',
    },
  })
}

describe('POST /billing/webhook (integration) — credits branch', () => {
  it('grants credits after signed credits-checkout event', async () => {
    const app = buildHarness()
    const store = new PostgresStore(testDb.db)
    const user = await store.upsertUser('u@example.com')

    const session = await billing.createCheckoutSession({
      userId: user.id, kind: 'credits',
      priceId: 'price_test_credits',
      successUrl: 's', cancelUrl: 'c',
    })
    await store.createStripePayment({
      gradeId: null, sessionId: session.id,
      amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    billing.completeSession(session.id, 2900, 'usd')

    const { body, signature } = billing.constructEvent({
      type: 'checkout.session.completed',
      sessionId: session.id,
      metadata: { kind: 'credits', userId: user.id, creditCount: '10' },
      amountTotal: 2900, currency: 'usd',
    })

    const res = await app.fetch(new Request('http://test/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    }))
    expect(res.status).toBe(200)

    expect(await store.getCredits(user.id)).toBe(10)
    const row = await store.getStripePaymentBySessionId(session.id)
    expect(row!.status).toBe('paid')
    expect(row!.kind).toBe('credits')
  }, 60_000)
})
```

- [ ] **Step 2: Write `billing-redeem-credit.test.ts`**

End-to-end: seed a free done grade + verified user with 3 credits → POST /billing/redeem-credit → let real `generate-report` worker run → assert `grade.tier='paid'` + credits=2.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { sql } from 'drizzle-orm'
import type Redis from 'ioredis'
import { QueueEvents } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { buildApp } from '../../src/server/app.ts'
import { getReportQueue, reportQueueName } from '../../src/queue/queues.ts'
import { registerGenerateReportWorker } from '../../src/queue/workers/generate-report/index.ts'
import { MockProvider } from '../../src/llm/providers/mock.ts'
import { signCookie } from '../../src/server/middleware/cookie-sign.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { FakeStripe } from '../unit/_helpers/fake-stripe.ts'
import { startTestDb, type TestDb } from './setup.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb
let redis: Redis

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  testDb = await startTestDb()
}, 120_000)

afterAll(async () => {
  await redis?.quit()
  await testDb.stop()
  await redisContainer.stop()
})

beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, scrapes, probes, cookies, users, magic_tokens, recommendations, reports CASCADE`)
  if (redis) await redis.quit()
  redis = createRedis(redisUrl)
  await redis.flushall()
})

function makeProviders() {
  const recsJson = JSON.stringify([
    { title: 'r1', category: 'recognition', impact: 5, effort: 2, rationale: 'r', how: 'h' },
    { title: 'r2', category: 'seo', impact: 4, effort: 2, rationale: 'r', how: 'h' },
    { title: 'r3', category: 'accuracy', impact: 3, effort: 3, rationale: 'r', how: 'h' },
    { title: 'r4', category: 'citation', impact: 2, effort: 1, rationale: 'r', how: 'h' },
    { title: 'r5', category: 'coverage', impact: 4, effort: 4, rationale: 'r', how: 'h' },
  ])
  const claude = new MockProvider({ id: 'claude', responses: (prompt) => {
    if (prompt.includes('GEO')) return recsJson
    if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
    if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
    return 'Acme widgets. Industrial leader.'
  }})
  return {
    claude,
    gpt: new MockProvider({ id: 'gpt', responses: () => 'Acme widgets' }),
    gemini: new MockProvider({ id: 'gemini', responses: () => 'Acme widgets' }),
    perplexity: new MockProvider({ id: 'perplexity', responses: () => 'Acme widgets' }),
  }
}

function buildHarness() {
  return buildApp({
    store: new PostgresStore(testDb.db),
    redis,
    redisFactory: () => createRedis(redisUrl),
    mailer: new FakeMailer(),
    billing: new FakeStripe('whsec_test_fake'),
    reportQueue: getReportQueue(redis),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: {
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: HMAC_KEY,
      PUBLIC_BASE_URL: 'http://localhost:5173',
      STRIPE_PRICE_ID: 'price_test_report',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
      STRIPE_CREDITS_PRICE_ID: 'price_test_credits',
    },
  })
}

describe('POST /billing/redeem-credit (integration) — full lifecycle', () => {
  it('redeems credit → worker runs → tier=paid, credits decrement, reports row written', async () => {
    const app = buildHarness()
    const store = new PostgresStore(testDb.db)

    // Seed: verified user with 3 credits, bound to a cookie
    const user = await store.upsertUser('u@example.com')
    const cookieUuid = crypto.randomUUID()
    await store.upsertCookie(cookieUuid, user.id)
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_seed', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_seed', user.id, 3, 2900, 'usd')

    // Seed a done grade owned by the cookie
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free', status: 'done',
      overall: 70, letter: 'C', cookie: cookieUuid,
      scores: { recognition: 80, seo: 80, accuracy: 50, coverage: 70, citation: 70, discoverability: 60 },
    })
    await store.createScrape({
      gradeId: grade.id, rendered: false,
      html: '<html>Acme widgets</html>', text: 'Acme widgets since 1902. '.repeat(20),
      structured: {
        jsonld: [], og: { title: 'Acme', description: 'Widgets', image: 'https://acme.com/og.png' },
        meta: { title: 'Acme', description: 'W', canonical: 'https://acme.com', twitterCard: 'summary' },
        headings: { h1: ['Acme'], h2: [] },
        robots: null, sitemap: { present: true, url: '' }, llmsTxt: { present: false, url: '' },
      } as never,
    })
    await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'claude', prompt: 'p', response: 'acme', score: 80, metadata: {} })
    await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'gpt', prompt: 'p', response: 'acme', score: 70, metadata: {} })

    // Register the worker so the job actually runs
    const worker = registerGenerateReportWorker({
      store, redis, providers: makeProviders(),
    }, redis)
    const queueEvents = new QueueEvents(reportQueueName, { connection: redis })
    await queueEvents.waitUntilReady()

    // POST the redeem endpoint with the signed cookie
    const signedCookie = signCookie(cookieUuid, HMAC_KEY)
    const res = await app.fetch(new Request('http://test/billing/redeem-credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${signedCookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(204)

    // Wait for the worker to complete the job
    const auditSessionId = `credit:${grade.id}`
    const jobId = `generate-report-${auditSessionId}`
    // BullMQ: find the job, wait until finished
    const reportQueue = getReportQueue(redis)
    const job = await reportQueue.getJob(jobId)
    expect(job).toBeDefined()
    await job!.waitUntilFinished(queueEvents, 60_000)

    // Assertions
    const updated = await store.getGrade(grade.id)
    expect(updated!.tier).toBe('paid')
    expect(await store.getCredits(user.id)).toBe(2)
    const report = await store.getReport(grade.id)
    expect(report).not.toBeNull()

    await worker.close()
    await queueEvents.close()
    await reportQueue.close()
  }, 120_000)
})
```

- [ ] **Step 3: Run both integration tests**

```
pnpm test:integration -- tests/integration/billing-buy-credits.test.ts tests/integration/billing-redeem-credit.test.ts
```

Expected: both pass.

- [ ] **Step 4: Full integration run**

`pnpm test:integration`
Expected: all green (possibly re-run once for the documented BullMQ/testcontainers flake).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/billing-buy-credits.test.ts tests/integration/billing-redeem-credit.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(billing): integration tests for buy-credits + redeem-credit lifecycle"
```

---

## Task 14: Docs — checklist + master-spec anchor + README

**Files:**
- Modify: `docs/production-checklist.md`
- Modify: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md`
- Modify: `README.md`

- [ ] **Step 1: Update production-checklist**

Add to the **Deploy / ops** section:

```markdown
- [ ] **Partial-consumption refund policy for credits.** MVP: support-email-driven, manual partial refund via Stripe admin. Before scale: codify (e.g. within 14 days, ≤2 used → full refund; 3-5 used → 50% refund; >5 used → no refund).
- [ ] **Admin credit-grant UI.** Direct SQL today (`UPDATE users SET credits = credits + 3 WHERE email = '...'`). Needs a small admin endpoint or dashboard once support volume grows.
- [ ] **Credit expiration policy (deferred).** MVP: never expire. Revisit if unused balances accumulate past 12 months — 2-year expiration post-purchase with a 30-day email warning is a reasonable default.
```

- [ ] **Step 2: Update master-spec anchor**

In `docs/superpowers/specs/2026-04-17-geo-reporter-design.md`, find `### 7.3 Paid tier`. Add below the existing anchor:

```markdown
> **Credit packs (added 2026-04-19).** Alongside the $19 one-off, users can buy 10 credits for $29 via a separate Stripe Checkout product. Each credit redeems for one full paid report at any time (same `generate-report` pipeline). Email verification is required to hold credits (balance portability across cookies/devices). Rate-limit tier rises to 10/24h while `users.credits > 0`. Email-only verification no longer grants a +10 bonus — verified email = identity only. See `docs/superpowers/specs/2026-04-19-geo-reporter-credits-pack-design.md`.
```

- [ ] **Step 3: Update README**

**Update the rate-limit tier explanation.** Find the existing description of the 3/24h → 13/24h tier and replace with:

```markdown
- **Anonymous** (cookie only): 3 grades per 24h.
- **Email-verified:** 3 grades per 24h (same as anonymous — email is just identity + credit balance portability).
- **Credit-holder:** 10 grades per 24h while `users.credits > 0`. Credits are $29 for 10, each redeems for a full paid report.
```

**Update the roadmap.** Add a row (or replace "Plan 9 — Reports" with both, or add "Plan 8.5 — Credits"):

```markdown
| 8.5 | Credits Pack ($29/10 reports) | **Done (2026-04-19)** |
```

**Update test counts** — run `pnpm test 2>&1 | tail -3` and `pnpm test:integration 2>&1 | tail -3` to get real numbers; update the "What runs today" table.

**Add a row to "What runs today":**

```markdown
| `POST /billing/buy-credits` + `POST /billing/redeem-credit` | Works. $29 Stripe Checkout for 10 credits; credits spend on `generate-report` without a round-trip to Stripe. |
```

- [ ] **Step 4: Full validation**

`pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm build` all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/production-checklist.md docs/superpowers/specs/2026-04-17-geo-reporter-design.md README.md
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "docs: credits-pack wrap-up — checklist, anchor, README"
```

---

## Final verification

- [ ] `pnpm test` — all unit tests pass.
- [ ] `pnpm test:integration` — all integration tests pass (re-run once if the documented BullMQ/testcontainers flake fires).
- [ ] `pnpm typecheck` — no errors.
- [ ] `pnpm build` — server + worker + web bundles all clean.
- [ ] **Manual smoke test:**
  1. In Stripe test-mode dashboard, create a second product: "Credits Pack — 10 reports" at $29 one-time. Copy the `price_...` → `STRIPE_CREDITS_PRICE_ID` in `.env`.
  2. Restart `pnpm dev:server`, `pnpm dev:worker`, `pnpm dev:web`, `stripe listen --forward-to localhost:7777/billing/webhook`.
  3. Sign in via magic link (email verification).
  4. Land on `/` — confirm "💎 Save 85%" CTA is visible.
  5. Click "Get credits" — redirected to Stripe test checkout. Use card `4242 4242 4242 4242`.
  6. Redirected to `/?credits=purchased` — toast fires, Header shows "10 credits" badge.
  7. Run a grade to done.
  8. On LiveGradePage, button now reads `Redeem 1 credit (9 left)`. Click.
  9. Banner transitions through generating → ready. Header updates to "9 credits".
  10. Try redeeming the same grade again → 409 already_paid.
  11. Check DB: `SELECT credits FROM users WHERE email = '<you>'` → 9. `SELECT tier, overall FROM grades WHERE id = '<id>'` → `paid`.
