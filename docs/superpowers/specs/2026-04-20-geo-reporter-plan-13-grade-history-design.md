# Plan 13 — Grade history for signed-in users design

**Date:** 2026-04-20
**Status:** Design
**Author:** Claude + Erika

## 1. Problem

Users who verify their email can't see grades they ran before verification, can't see grades they ran on other devices, and can't access any grade from a browser with a different cookie. Grades are keyed by `cookie` only, both on creation and on access checks.

## 2. Decisions

| ID | Decision |
|----|----------|
| P13-1 | **Ownership = cookie OR userId.** Every endpoint that currently checks `grade.cookie === c.var.cookie` adds an OR fallback to `grade.userId === c.var.userId` (when the caller is verified). |
| P13-2 | **Retroactive grade binding on verify spans all of a user's cookies.** When a magic-link verify succeeds, set `grades.user_id = <userId>` for every grade whose `cookie` is (or ever was) bound to that userId. Handles the "verified from phone, then signed in on laptop" case. |
| P13-3 | **New list endpoint: `GET /grades`** returns up to 50 grades ordered by `created_at DESC`, for the logged-in user's userId. Unverified users get a 401. (Anonymous users have their grades keyed to their cookie anyway — they can reach any grade by URL. A list-by-cookie endpoint isn't worth the cost for anonymous tier.) |
| P13-4 | **History UI lives on `/account`** — new section "Your grades" between credits and delete. Lists domain, overall letter/score, tier badge (free/paid), created date, "view" link to `/g/<id>`. Empty state: "No grades yet. Run one from the home page." |
| P13-5 | **Shared ownership helper.** Factor the ownership check into `src/server/lib/grade-ownership.ts` so the 4 endpoints (`GET /grades/:id`, `GET /grades/events/:id`, billing checkout/redeem, `GET /report/:id`) share one function. Reduces drift risk. |
| P13-6 | **Order of retroactive binding in `consumeMagicToken`.** Bind the clicking cookie to the user FIRST, THEN run the UPDATE so the clicking cookie is included. Both in the same transaction. |
| P13-7 | **No schema changes.** `grades.user_id` and `cookies.user_id` both exist today (both nullable). No migration required. |

## 3. Architecture

### 3.1 Ownership check — new helper at `src/server/lib/grade-ownership.ts`

```ts
export interface Ownable { cookie: string; userId: string | null }
export interface Caller { cookie: string; userId: string | null }

export function isOwnedBy(grade: Ownable, caller: Caller): boolean {
  if (grade.cookie === caller.cookie) return true
  if (caller.userId !== null && grade.userId === caller.userId) return true
  return false
}
```

Callers need `userId` from `c.var`. Today middleware exposes `cookie` and `clientIp`; we add `userId` via a small helper that reads `getCookieWithUserAndCredits` once per request and caches on `c.var.userId`.

### 3.2 Retroactive binding — `PostgresStore.consumeMagicToken`

Inside the existing transaction, add after `upsertCookie(clickingCookie, user.id)`:

```sql
UPDATE grades
SET user_id = $1
WHERE user_id IS NULL
  AND cookie IN (SELECT cookie FROM cookies WHERE user_id = $1)
```

This binds every grade whose cookie is now (including the just-bound clicking cookie) or was ever bound to this user. `user_id IS NULL` guard ensures we never stomp on a grade already owned by a different user.

### 3.3 List endpoint — `GET /grades`

Requires cookie middleware + a userId. Returns JSON:

```ts
{ grades: Array<{ id, domain, url, tier, status, overall, letter, createdAt }> }
```

Implementation:
```ts
app.get('/', async (c) => {
  const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
  if (row.userId === null) return c.json({ error: 'must_verify_email' }, 401)
  const grades = await deps.store.listGradesByUser(row.userId, 50)
  return c.json({ grades: grades.map(toSummary) })
})
```

### 3.4 New store method — `PostgresStore.listGradesByUser(userId, limit)`

Query:
```ts
SELECT id, domain, url, tier, status, overall, letter, created_at
FROM grades
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT $2
```

Uses the existing `grades_user_id_idx` index.

### 3.5 Frontend — `AccountPage.tsx`

New section below credits, above delete:

```tsx
<section className="mb-8">
  <div className="text-xs uppercase tracking-wider text-[var(--color-fg-muted)] mb-2">your grades</div>
  <GradeHistoryList />
</section>
```

`GradeHistoryList` — fetches on mount, shows loading/empty/list states. Each row: domain + url truncated, letter + overall, tier badge, date, view link.

### 3.6 Frontend API — `src/web/lib/api.ts`

```ts
export interface GradeSummary {
  id: string
  url: string
  domain: string
  tier: 'free' | 'paid'
  status: 'queued' | 'running' | 'done' | 'failed'
  overall: number | null
  letter: string | null
  createdAt: string
}
export async function listMyGrades(): Promise<GradeSummary[]>
```

## 4. Endpoints that get the ownership-check upgrade

1. `GET /grades/:id` — `src/server/routes/grades.ts`
2. `GET /grades/events/:id` — `src/server/routes/grades-events.ts`
3. `POST /billing/checkout` — `src/server/routes/billing.ts` (grade lookup)
4. `POST /billing/redeem-credit` — same file
5. `GET /report/:id` and `GET /report/:id.pdf` — `src/server/routes/report.ts` (via grade ownership lookup if present; check first)

Each site pulls `c.var.userId` (from the new helper middleware addition) and passes both to `isOwnedBy`.

## 5. Testing

Unit:
- `isOwnedBy` — 4 cases (cookie match, userId match, no match, anon caller)
- `listGradesByUser` on fake-store
- `GET /grades` — 401 when unverified, 200 with sorted list when verified
- Each of the 4 ownership-check endpoints: verified user with different cookie but matching userId → allowed

Integration:
- `consumeMagicToken` binds grades from the clicking cookie AND prior cookies for that user
- `listGradesByUser` returns only the user's grades, newest first, limit honored

Frontend unit:
- `GradeHistoryList` renders loading → list / empty / error states
- AccountPage includes `GradeHistoryList` between credits and delete

## 6. Out of scope

- Pagination beyond 50 most-recent (add when a user hits the ceiling).
- Search / filter on the grades list.
- Anonymous grade history (users without an email can still access grades via direct URL, the existing cookie-based flow).
- Bulk delete from the history UI — delete-account still covers nuke-everything; individual delete is future work.

## 7. Risks

- **Security boundary.** The `isOwnedBy` helper is the single gate. A bug here leaks data cross-user. Mitigated by: (a) single shared helper with unit tests, (b) existing cookie check stays in place (both must individually be safe).
- **Retroactive binding race.** If two magic-link verifies for different users happen to hold the same cookie mid-flight (unlikely — one cookie is bound to one user), the `user_id IS NULL` guard still protects. Grades never get re-bound to a different user.
