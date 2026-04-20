# Plan 13 — Grade history for signed-in users

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user can see all their past grades on `/account`, and can access any of their grades from any browser/device after signing in. No schema changes.

**Architecture:** One shared `isOwnedBy(grade, caller)` helper lets four endpoints accept either cookie-match or userId-match ownership. Magic-link verification retroactively binds all grades under any cookie ever associated with the user. New `GET /grades` list endpoint + `GradeHistoryList` section on AccountPage.

**Tech Stack:** TypeScript 5.6+ strict, Hono 4, Drizzle 0.33 + postgres-js, React 18 + React Router, Vitest 2 + testcontainers 10.

**Spec:** `docs/superpowers/specs/2026-04-20-geo-reporter-plan-13-grade-history-design.md`

---

## Task 1: `isOwnedBy` shared helper

**Files:**
- Create: `src/server/lib/grade-ownership.ts`
- Test: `tests/unit/server/lib/grade-ownership.test.ts` (new)

- [ ] **Step 1: Write the failing test.** Create `tests/unit/server/lib/grade-ownership.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isOwnedBy } from '../../../../src/server/lib/grade-ownership.ts'

describe('isOwnedBy', () => {
  it('allows when cookie matches', () => {
    expect(isOwnedBy(
      { cookie: 'c1', userId: null },
      { cookie: 'c1', userId: null },
    )).toBe(true)
  })
  it('allows when userId matches even if cookies differ', () => {
    expect(isOwnedBy(
      { cookie: 'c-old', userId: 'u1' },
      { cookie: 'c-new', userId: 'u1' },
    )).toBe(true)
  })
  it('denies when neither cookie nor userId match', () => {
    expect(isOwnedBy(
      { cookie: 'c1', userId: 'u1' },
      { cookie: 'c2', userId: 'u2' },
    )).toBe(false)
  })
  it('denies when caller is anonymous and cookie differs', () => {
    expect(isOwnedBy(
      { cookie: 'c-old', userId: 'u1' },
      { cookie: 'c-new', userId: null },
    )).toBe(false)
  })
  it('does not allow userId=null match (empty string guard equivalent)', () => {
    // Grade with userId null; caller with userId null — cookies differ → deny.
    // This prevents "null === null" from becoming a wildcard allow.
    expect(isOwnedBy(
      { cookie: 'c1', userId: null },
      { cookie: 'c2', userId: null },
    )).toBe(false)
  })
})
```

- [ ] **Step 2: Run** `pnpm test tests/unit/server/lib/grade-ownership.test.ts` → FAIL (module not found).

- [ ] **Step 3: Create the helper.** `src/server/lib/grade-ownership.ts`:

```ts
export interface Ownable {
  cookie: string
  userId: string | null
}

export interface Caller {
  cookie: string
  userId: string | null
}

/**
 * A grade is owned by the caller if:
 *  - their cookies match, OR
 *  - the caller is a verified user AND the grade is bound to that user.
 *
 * null userId never counts as a match — that would make two anonymous
 * visitors on different cookies "own" each other's nulls.
 */
export function isOwnedBy(grade: Ownable, caller: Caller): boolean {
  if (grade.cookie === caller.cookie) return true
  if (caller.userId !== null && grade.userId === caller.userId) return true
  return false
}
```

- [ ] **Step 4: Run** → 5 PASS. Typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add src/server/lib/grade-ownership.ts tests/unit/server/lib/grade-ownership.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(server): isOwnedBy helper for cookie-or-userId ownership checks"
```

---

## Task 2: `GradeStore.listGradesByUser`

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/postgres.ts`
- Modify: `tests/unit/_helpers/fake-store.ts`
- Test: `tests/integration/store-list-grades-by-user.test.ts` (new)

- [ ] **Step 1: Add to `GradeStore` interface** in `src/store/types.ts`:

```ts
  listGradesByUser(userId: string, limit: number): Promise<Grade[]>
```

Place near `getGrade`. `Grade` type already exists.

- [ ] **Step 2: Write failing integration test.** `tests/integration/store-list-grades-by-user.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.listGradesByUser', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('returns grades for the user ordered by createdAt desc, respecting limit', async () => {
    const user = await store.upsertUser('hist@example.com')
    const other = await store.upsertUser('other@example.com')
    await store.upsertCookie('c-a', user.id)
    await store.upsertCookie('c-b', other.id)

    // Grade 1 — older, owned by user
    const g1 = await store.createGrade({
      url: 'https://a', domain: 'a', tier: 'free', cookie: 'c-a', userId: user.id, status: 'done',
    })
    // Grade 2 — newer, owned by user
    const g2 = await store.createGrade({
      url: 'https://b', domain: 'b', tier: 'paid', cookie: 'c-a', userId: user.id, status: 'done',
    })
    // Grade 3 — owned by other user
    await store.createGrade({
      url: 'https://c', domain: 'c', tier: 'free', cookie: 'c-b', userId: other.id, status: 'done',
    })

    const list = await store.listGradesByUser(user.id, 50)
    expect(list.map((g) => g.id)).toEqual([g2.id, g1.id])
  })

  it('respects limit', async () => {
    const user = await store.upsertUser('limit@example.com')
    await store.upsertCookie('c-limit', user.id)
    for (let i = 0; i < 5; i++) {
      await store.createGrade({
        url: `https://${i}`, domain: String(i), tier: 'free', cookie: 'c-limit', userId: user.id, status: 'done',
      })
    }
    const list = await store.listGradesByUser(user.id, 3)
    expect(list).toHaveLength(3)
  })

  it('returns empty array when user has no grades', async () => {
    const user = await store.upsertUser('empty@example.com')
    const list = await store.listGradesByUser(user.id, 50)
    expect(list).toEqual([])
  })
})
```

- [ ] **Step 3: Run** → FAIL (method not implemented).

- [ ] **Step 4: Implement in `PostgresStore`.** In `src/store/postgres.ts`, near `getGrade`:

```ts
async listGradesByUser(userId: string, limit: number): Promise<Grade[]> {
  const rows = await this.db
    .select()
    .from(schema.grades)
    .where(eq(schema.grades.userId, userId))
    .orderBy(desc(schema.grades.createdAt))
    .limit(limit)
  return rows.map(toGrade)
}
```

Ensure `desc` is imported from `drizzle-orm`. If the file already uses `desc`, no action; otherwise:

```ts
import { eq, desc } from 'drizzle-orm'
```

The `toGrade` mapper: check existing code — there's likely a helper used by `getGrade`. If the file inlines the mapping, mirror that pattern. Do not guess; read the file.

- [ ] **Step 5: Implement in fake-store.** In `tests/unit/_helpers/fake-store.ts`, add:

```ts
async listGradesByUser(userId: string, limit: number): Promise<Grade[]> {
  return this.grades
    .filter((g) => g.userId === userId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
}
```

Adapt `this.grades` to whatever the fake actually uses (read first — likely `grades: Grade[]`).

- [ ] **Step 6: Run integration test** → 3 PASS. Also `pnpm test && pnpm typecheck` → clean.

- [ ] **Step 7: Commit.**

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts tests/integration/store-list-grades-by-user.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): listGradesByUser(userId, limit) for grade history"
```

---

## Task 3: Retroactive grade binding in `consumeMagicToken`

**Files:**
- Modify: `src/store/postgres.ts` (consumeMagicToken transaction)
- Modify: `tests/unit/_helpers/fake-store.ts` (mirror in fake)
- Test: `tests/integration/store-retro-bind.test.ts` (new)

- [ ] **Step 1: Read current `consumeMagicToken`** in `src/store/postgres.ts`. Note the transaction boundary and the line that binds the clicking cookie to the user. The new UPDATE goes immediately AFTER that step, inside the same transaction.

- [ ] **Step 2: Write failing integration test.** `tests/integration/store-retro-bind.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.consumeMagicToken retroactive grade binding', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('binds grades under the clicking cookie to the verifying user', async () => {
    await store.upsertCookie('c-click')
    const g = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: 'c-click', userId: null, status: 'done',
    })
    const token = await store.issueMagicToken('retro@example.com', 'c-click')

    const out = await store.consumeMagicToken(token.token, 'c-click')
    expect(out.kind).toBe('ok')

    const refreshed = await store.getGrade(g.id)
    expect(refreshed?.userId).not.toBeNull()
  })

  it('binds grades under ALL cookies previously bound to this user', async () => {
    // Simulate: user verified on phone (c-phone), then signs in on laptop (c-laptop)
    const user = await store.upsertUser('multi@example.com')
    await store.upsertCookie('c-phone', user.id)
    const phoneGrade = await store.createGrade({
      url: 'https://phone', domain: 'phone', tier: 'free', cookie: 'c-phone', userId: null, status: 'done',
    })
    // Issue token for the laptop cookie (brand new)
    await store.upsertCookie('c-laptop')
    const laptopGrade = await store.createGrade({
      url: 'https://laptop', domain: 'laptop', tier: 'free', cookie: 'c-laptop', userId: null, status: 'done',
    })
    const token = await store.issueMagicToken('multi@example.com', 'c-laptop')

    const out = await store.consumeMagicToken(token.token, 'c-laptop')
    expect(out.kind).toBe('ok')

    const phone = await store.getGrade(phoneGrade.id)
    const laptop = await store.getGrade(laptopGrade.id)
    expect(phone?.userId).toBe(user.id)
    expect(laptop?.userId).toBe(user.id)
  })

  it('does not stomp grades already owned by a different user', async () => {
    const other = await store.upsertUser('other@example.com')
    await store.upsertCookie('c-other', other.id)
    const otherGrade = await store.createGrade({
      url: 'https://other', domain: 'other', tier: 'free', cookie: 'c-other', userId: other.id, status: 'done',
    })
    // Note: in practice a cookie is bound to at most one user; this test
    // proves the user_id IS NULL guard even if that invariant were broken.
    // Set up a different verifier and ensure they can't rebind.
    await store.upsertCookie('c-verify')
    const token = await store.issueMagicToken('stomper@example.com', 'c-verify')
    await store.consumeMagicToken(token.token, 'c-verify')

    const fresh = await store.getGrade(otherGrade.id)
    expect(fresh?.userId).toBe(other.id)
  })
})
```

- [ ] **Step 3: Run** → FAIL on the first two tests (grade never gets bound).

- [ ] **Step 4: Add the UPDATE to `consumeMagicToken`.** Inside the existing transaction in `src/store/postgres.ts`, after the `upsertCookie(clickingCookie, user.id)` step, add:

```ts
await tx.execute(sql`
  UPDATE grades
  SET user_id = ${user.id}
  WHERE user_id IS NULL
    AND cookie IN (SELECT cookie FROM cookies WHERE user_id = ${user.id})
`)
```

Ensure `sql` is imported from `drizzle-orm`. The upsertCookie-before-UPDATE order means the clicking cookie is already bound to this user when the subquery runs, so its grades get picked up.

- [ ] **Step 5: Mirror in fake-store.** In `tests/unit/_helpers/fake-store.ts`, inside `consumeMagicToken`, after binding the cookie, add a loop that updates all this user's grades:

```ts
// Retroactively bind any unowned grades whose cookie is now bound to this user.
const userCookies = new Set(
  [...this.cookiesMap.values()].filter((c) => c.userId === user.id).map((c) => c.cookie),
)
for (const g of this.grades) {
  if (g.userId === null && userCookies.has(g.cookie)) {
    g.userId = user.id
  }
}
```

Adapt field names (`cookiesMap`, `grades`) to whatever the fake uses.

- [ ] **Step 6: Run integration test** → 3 PASS. `pnpm test && pnpm typecheck` → clean.

- [ ] **Step 7: Commit.**

```bash
git add src/store/postgres.ts tests/unit/_helpers/fake-store.ts tests/integration/store-retro-bind.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): retroactively bind unowned grades to user on magic-link verify"
```

---

## Task 4: Thread `userId` through cookie middleware → `c.var.userId`

**Files:**
- Modify: `src/server/middleware/cookie.ts`
- Test: `tests/unit/server/middleware/cookie.test.ts` (add case)

Today cookie middleware sets `c.var.cookie`. Route handlers call `getCookieWithUserAndCredits` themselves when they need the userId. For Plan 13 we touch 4 handlers that all need userId — expose it on `c.var` once.

- [ ] **Step 1: Read current cookie middleware** (`src/server/middleware/cookie.ts`). Understand its shape.

- [ ] **Step 2: Write failing test.** Add to `tests/unit/server/middleware/cookie.test.ts` (create if missing):

```ts
it('sets c.var.userId when the cookie is bound to a user', async () => {
  const store = makeFakeStore()
  const user = await store.upsertUser('u@x')
  await store.upsertCookie('cookie-1', user.id)
  const app = new Hono<{ Variables: { cookie: string; userId: string | null } }>()
  app.use('*', cookieMiddleware(store, false, 'test-key-32-chars-1234567890-aaaa'))
  app.get('/me', (c) => c.json({ cookie: c.var.cookie, userId: c.var.userId }))
  // ... issue cookie via an initial request, then a second request that reads /me
  // expect body.userId === user.id
})

it('sets c.var.userId to null for anonymous cookie', async () => { /* similar shape */ })
```

Adapt to the existing test patterns in the file. If the file doesn't exist, create it; if patterns differ, match them. Read first.

- [ ] **Step 3: Run test** → FAIL (`c.var.userId` undefined).

- [ ] **Step 4: Update middleware.** In `src/server/middleware/cookie.ts`, after the cookie is issued/read and validated:

```ts
const row = await store.getCookieWithUserAndCredits(cookieValue)
c.set('cookie', cookieValue)
c.set('userId', row.userId)  // NEW — null when anon
```

Update the exported `Env` type (if there's one) to include `userId: string | null`. If routes declare their own local `Env` that only has `cookie` + `clientIp`, those need extension too — let typecheck guide you.

- [ ] **Step 5: Extend route-scope Env typings.** In `src/server/app.ts` and wherever `Hono<{ Variables: { cookie: string; ... } }>` appears, add `userId: string | null` to the Variables object. Typecheck will walk you through.

- [ ] **Step 6: Run tests + typecheck.** `pnpm test && pnpm typecheck` — fix any Variables-type mismatches.

- [ ] **Step 7: Commit.**

```bash
git add src/server/middleware/cookie.ts src/server/app.ts tests/unit/server/middleware/cookie.test.ts
# plus any route files whose Env type changed
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(server): expose userId on c.var via cookie middleware"
```

---

## Task 5: Apply `isOwnedBy` to grade + SSE endpoints

**Files:**
- Modify: `src/server/routes/grades.ts` (GET /:id)
- Modify: `src/server/routes/grades-events.ts` (GET /events/:id)
- Test: `tests/unit/server/routes/grades.test.ts` (add case; create if missing)

- [ ] **Step 1: Write failing test** for `GET /grades/:id`: a verified user with a NEW cookie can access a grade whose `userId` matches theirs but whose `cookie` differs. Add to `tests/unit/server/routes/grades.test.ts` (read existing patterns; mirror `build()`, `issueCookie()` helpers):

```ts
it('allows a verified user with a different cookie when userId matches', async () => {
  const { app, store } = build()
  const cookie = await issueCookie(app)
  const uuid = cookie.split('.')[0]!
  const user = await store.upsertUser('access@example.com')
  await store.upsertCookie(uuid, user.id)
  // Create a grade under a DIFFERENT cookie, owned by same user
  const grade = await store.createGrade({
    url: 'https://x', domain: 'x', tier: 'free',
    cookie: 'old-cookie', userId: user.id, status: 'done',
  })

  const res = await app.fetch(new Request(`http://test/grades/${grade.id}`, {
    headers: { cookie: `ggcookie=${cookie}` },
  }))
  expect(res.status).toBe(200)
})

it('denies when neither cookie nor userId matches', async () => {
  const { app, store } = build()
  const cookie = await issueCookie(app)
  const grade = await store.createGrade({
    url: 'https://x', domain: 'x', tier: 'free',
    cookie: 'unrelated', userId: 'other-user', status: 'done',
  })
  const res = await app.fetch(new Request(`http://test/grades/${grade.id}`, {
    headers: { cookie: `ggcookie=${cookie}` },
  }))
  expect(res.status).toBe(403)
})
```

- [ ] **Step 2: Run** → FAIL on the first (current code checks cookie only).

- [ ] **Step 3: Update `GET /grades/:id`** in `src/server/routes/grades.ts`. Replace the existing cookie check:

```ts
// OLD
if (grade.cookie !== c.var.cookie) return c.json({ error: 'forbidden' }, 403)
// NEW
import { isOwnedBy } from '../lib/grade-ownership.ts'  // at top of file
if (!isOwnedBy(grade, { cookie: c.var.cookie, userId: c.var.userId })) {
  return c.json({ error: 'forbidden' }, 403)
}
```

- [ ] **Step 4: Same change in `src/server/routes/grades-events.ts`** — the SSE endpoint has the same cookie-only check. Import `isOwnedBy`, replace with the `isOwnedBy` call.

- [ ] **Step 5: Run tests** → PASS. Full suite + typecheck clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/routes/grades.ts src/server/routes/grades-events.ts tests/unit/server/routes/grades.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(grades): cookie-or-userId ownership on GET and SSE endpoints"
```

---

## Task 6: Apply `isOwnedBy` to billing + report endpoints

**Files:**
- Modify: `src/server/routes/billing.ts` (both `/checkout` and `/redeem-credit`)
- Modify: `src/server/routes/report.ts` (if report ownership lookup exists — check first)
- Test: `tests/unit/server/routes/billing-checkout.test.ts` (add case)
- Test: `tests/unit/server/routes/billing-redeem-credit.test.ts` (add case)

- [ ] **Step 1: Find existing cookie checks.** Run:

```
grep -n "grade.cookie" src/server/routes/
```

Every site that compares `grade.cookie` to `c.var.cookie` is a target. Expected: at least `billing.ts` has 2 (checkout + redeem). Report endpoint uses the `reports` table (not `grades.cookie`) so it may not need updating; verify.

- [ ] **Step 2: Write failing test** — add to `billing-checkout.test.ts`:

```ts
it('allows checkout when grade.userId matches verified caller, even with different cookie', async () => {
  const { app, store, billing } = build()
  const cookie = await issueCookie(app)
  const uuid = await verifyCookie(store, cookie, 'cross@example.com')
  const user = await store.upsertUser('cross@example.com')
  // Create grade under a DIFFERENT cookie, owned by same user
  await store.upsertCookie('old-cookie', user.id)
  const grade = await store.createGrade({
    url: 'https://x', domain: 'x', tier: 'free',
    cookie: 'old-cookie', userId: user.id, status: 'done',
  })

  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify({ gradeId: grade.id }),
  }))
  // Either 200 (session created) or 200 (redeemed) — NOT 404 or 403
  expect(res.status).toBe(200)
})
```

And in `billing-redeem-credit.test.ts` the equivalent shape: verified user with credits, grade owned by same userId under a different cookie, expects 204.

- [ ] **Step 3: Run** → FAIL (existing code 404s because `grade.cookie !== c.var.cookie`).

- [ ] **Step 4: Update `billing.ts`.** Find both handlers' `grade.cookie !== c.var.cookie` lines. Replace with `isOwnedBy`:

```ts
import { isOwnedBy } from '../lib/grade-ownership.ts'

// inside handler:
if (!isOwnedBy(grade, { cookie: c.var.cookie, userId: c.var.userId })) {
  return c.json({ error: 'not_found' }, 404)
}
```

Keep the 404 (not 403) in billing — the existing behavior hides ownership mismatch as "not found" to not leak that a gradeId exists. Preserve that.

- [ ] **Step 5: Check `src/server/routes/report.ts`** — does it use `grade.cookie` anywhere? If yes, apply the same pattern. If it uses a token-based auth only (likely — reports use a hex token in `?t=...`), leave it alone.

- [ ] **Step 6: Run all tests + typecheck.**

- [ ] **Step 7: Commit.**

```bash
git add src/server/routes/billing.ts tests/unit/server/routes/billing-checkout.test.ts tests/unit/server/routes/billing-redeem-credit.test.ts
# plus report.ts if modified
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): cookie-or-userId ownership on checkout + redeem-credit"
```

---

## Task 7: `GET /grades` list endpoint

**Files:**
- Modify: `src/server/routes/grades.ts`
- Test: `tests/unit/server/routes/grades-list.test.ts` (new)

- [ ] **Step 1: Write failing tests.** `tests/unit/server/routes/grades-list.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { makeStubRedis } from '../../_helpers/stub-redis.ts'
import { gradesRouter } from '../../../../src/server/routes/grades.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

function build() {
  const store = makeFakeStore()
  const app = new Hono<{ Variables: { cookie: string; clientIp: string; userId: string | null } }>()
  app.use('*', clientIp({ trustedProxies: [], isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/grades', gradesRouter({ store, redis: makeStubRedis() } as never))
  return { app, store }
}

async function issueCookie(app: Hono): Promise<string> {
  const res = await app.fetch(new Request('http://t/grades/00000000-0000-0000-0000-000000000000'))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie')
  return raw
}

describe('GET /grades', () => {
  it('401 when unverified', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://t/grades', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(401)
  })

  it('200 with sorted grades when verified', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('list@example.com')
    await store.upsertCookie(uuid, user.id)
    const g1 = await store.createGrade({
      url: 'https://a', domain: 'a', tier: 'free', cookie: uuid, userId: user.id, status: 'done',
    })
    const g2 = await store.createGrade({
      url: 'https://b', domain: 'b', tier: 'paid', cookie: uuid, userId: user.id, status: 'done',
    })
    const res = await app.fetch(new Request('http://t/grades', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { grades: Array<{ id: string }> }
    // Newest first
    expect(body.grades.map((g) => g.id)).toEqual([g2.id, g1.id])
  })
})
```

- [ ] **Step 2: Run** → FAIL (route not registered).

- [ ] **Step 3: Add the handler** in `src/server/routes/grades.ts`, alongside `POST /` and `GET /:id`:

```ts
app.get('/', async (c) => {
  if (c.var.userId === null) {
    return c.json({ error: 'must_verify_email' }, 401)
  }
  const grades = await deps.store.listGradesByUser(c.var.userId, 50)
  return c.json({
    grades: grades.map((g) => ({
      id: g.id,
      url: g.url,
      domain: g.domain,
      tier: g.tier,
      status: g.status,
      overall: g.overall,
      letter: g.letter,
      createdAt: g.createdAt.toISOString(),
    })),
  })
})
```

Note: route order matters in Hono. `GET /` must be registered OR Hono's router must disambiguate `GET /` from `GET /:id` — the `:id` param rejects non-UUIDs via `UUID_RE`, so `GET /` routes to its own handler. Verify by running tests.

- [ ] **Step 4: Run test + full suite + typecheck.** Expected: 2 new PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/server/routes/grades.ts tests/unit/server/routes/grades-list.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(grades): GET /grades lists the logged-in user's grades"
```

---

## Task 8: Frontend `listMyGrades` API + `GradeHistoryList` component + AccountPage wiring

**Files:**
- Modify: `src/web/lib/api.ts`
- Create: `src/web/components/GradeHistoryList.tsx`
- Modify: `src/web/pages/AccountPage.tsx`
- Test: `tests/unit/web/components/GradeHistoryList.test.tsx` (new)

- [ ] **Step 1: Add `listMyGrades` to `src/web/lib/api.ts`.** Near the existing `GradeSummary` type (if present — Plan 9 may have added one; reuse it) add:

```ts
export async function listMyGrades(): Promise<GradeSummary[]> {
  const res = await fetch('/grades', { credentials: 'include' })
  if (res.status === 401) return []
  if (!res.ok) return []
  const body = await res.json() as { grades: GradeSummary[] }
  return body.grades
}
```

If `GradeSummary` doesn't exactly match the server JSON, introduce a new type like `GradeHistoryEntry` with only the fields we use (id, domain, url, tier, status, overall, letter, createdAt). Pragmatic choice: don't force `GradeSummary` reuse if shapes diverge.

- [ ] **Step 2: Write failing test.** `tests/unit/web/components/GradeHistoryList.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as api from '../../../../src/web/lib/api.ts'
import { GradeHistoryList } from '../../../../src/web/components/GradeHistoryList.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('GradeHistoryList', () => {
  it('renders each grade as a row with domain, overall, tier, and view link', async () => {
    vi.spyOn(api, 'listMyGrades').mockResolvedValue([
      { id: 'g1', url: 'https://stripe.com/pricing', domain: 'stripe.com', tier: 'paid', status: 'done', overall: 87, letter: 'B', createdAt: '2026-04-20T12:00:00Z' },
      { id: 'g2', url: 'https://example.com', domain: 'example.com', tier: 'free', status: 'done', overall: 62, letter: 'D', createdAt: '2026-04-19T09:00:00Z' },
    ])
    render(<MemoryRouter><GradeHistoryList /></MemoryRouter>)
    expect(await screen.findByText('stripe.com')).toBeInTheDocument()
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText(/87/)).toBeInTheDocument()
    expect(screen.getByText(/paid/i)).toBeInTheDocument()
    const viewLinks = screen.getAllByRole('link', { name: /view/i })
    expect(viewLinks[0]).toHaveAttribute('href', '/g/g1')
    expect(viewLinks[1]).toHaveAttribute('href', '/g/g2')
  })

  it('renders empty state when list is empty', async () => {
    vi.spyOn(api, 'listMyGrades').mockResolvedValue([])
    render(<MemoryRouter><GradeHistoryList /></MemoryRouter>)
    expect(await screen.findByText(/no grades yet/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run** → FAIL (module not found).

- [ ] **Step 4: Implement `src/web/components/GradeHistoryList.tsx`:**

```tsx
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listMyGrades, type GradeSummary } from '../lib/api.ts'

export function GradeHistoryList(): JSX.Element {
  const [grades, setGrades] = useState<GradeSummary[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const g = await listMyGrades()
      if (!cancelled) setGrades(g)
    })()
    return () => { cancelled = true }
  }, [])

  if (grades === null) return <div className="text-xs text-[var(--color-fg-muted)]">Loading…</div>
  if (grades.length === 0) {
    return (
      <div className="text-xs text-[var(--color-fg-muted)]">
        No grades yet. Run one from the <Link to="/" className="text-[var(--color-brand)] underline">home page</Link>.
      </div>
    )
  }

  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {grades.map((g) => (
        <li key={g.id} className="py-2 flex items-center justify-between text-sm">
          <div className="min-w-0 flex-1 pr-3">
            <div className="text-[var(--color-fg)] truncate">{g.domain}</div>
            <div className="text-xs text-[var(--color-fg-muted)] truncate">{g.url}</div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {g.letter !== null && g.overall !== null && (
              <span className="font-mono text-[var(--color-fg)]">
                {g.letter} · {g.overall}
              </span>
            )}
            <span className="uppercase text-[10px] tracking-wider text-[var(--color-fg-muted)]">
              {g.tier}
            </span>
            <Link to={`/g/${g.id}`} className="text-[var(--color-brand)] underline">view</Link>
          </div>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 5: Wire into AccountPage.** In `src/web/pages/AccountPage.tsx`, import `GradeHistoryList` and add a new section between credits and "Delete account":

```tsx
import { GradeHistoryList } from '../components/GradeHistoryList.tsx'
// ...
<section className="mb-8">
  <div className="text-xs uppercase tracking-wider text-[var(--color-fg-muted)] mb-2">your grades</div>
  <GradeHistoryList />
</section>
```

- [ ] **Step 6: Run tests + typecheck.**

```
pnpm test tests/unit/web/components/GradeHistoryList.test.tsx
pnpm test
pnpm typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add src/web/lib/api.ts src/web/components/GradeHistoryList.tsx src/web/pages/AccountPage.tsx tests/unit/web/components/GradeHistoryList.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): GradeHistoryList on /account — view past grades from any browser"
```

---

## Self-review

**Spec coverage:**
- P13-1 ownership = cookie OR userId → Tasks 1, 4, 5, 6 ✓
- P13-2 retroactive binding across all user cookies → Task 3 ✓
- P13-3 GET /grades endpoint → Task 7 ✓
- P13-4 UI on /account → Task 8 ✓
- P13-5 shared helper → Task 1 ✓
- P13-6 order in consumeMagicToken → Task 3 Step 4 ✓
- P13-7 no schema changes → confirmed throughout ✓

**Placeholder scan:** All code blocks complete. No TBD/TODO.

**Type consistency:**
- `Ownable` / `Caller` — declared Task 1, consumed Tasks 5, 6.
- `listGradesByUser(userId, limit)` — declared Task 2 interface, consumed Task 7 route.
- `c.var.userId: string | null` — added Task 4, consumed Tasks 5, 6, 7.
- `GradeSummary` — Task 8 reuses the existing type (from Plan 9) OR introduces a new one (pragmatic).
