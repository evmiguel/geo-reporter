# GEO Reporter — Plan 7 (magic-link auth) design

> Sub-spec for Plan 7. Expands master spec §7.2 (email tier / magic-link). Brainstormed 2026-04-19. Covers: `/auth/magic`, `/auth/verify`, `/auth/logout`, `/auth/me`, cookie HMAC signing, `Mailer` interface (+ `ConsoleMailer`), auth rate-limiting, and the frontend wiring that makes the existing `EmailGatePage` actually work.

## 1. Scope

Plan 7 makes the anonymous rate-limit ceiling liftable. An anonymous visitor hits 3 grades/24h, is redirected to `/email`, types their address, clicks a link in their email, and becomes a verified visitor with a 13 grades/24h ceiling — their `cookies.user_id` now points at a `users` row, which the existing rate-limit middleware (`src/server/middleware/rate-limit.ts`) already keys off.

**In scope**
- `POST /auth/magic` — issues a magic link, emails it via `Mailer`.
- `GET /auth/verify` — validates the token, binds the clicking cookie to a user, redirects to the landing page.
- `POST /auth/logout` — unbinds the current cookie; cookie itself stays.
- `GET /auth/me` — returns `{ verified, email? }` so the frontend knows whether to show "sign out".
- Cookie HMAC signing — `ggcookie` upgrades from plain UUID to `<uuid>.<hmac>`.
- `Mailer` interface + `ConsoleMailer` (real provider deferred to Plan 10).
- Two new rate-limit buckets on `/auth/magic`: per-email (1/60s) and per-IP (5/10m).
- Frontend: `EmailGatePage` resend-link button, `LandingPage` verified-toast and auth-error banner, `Header` sign-out link, `useAuth` hook.

**Out of scope**
- Real email provider (Resend/Postmark) — Plan 10.
- `/my/grades` page — its own follow-up plan (needs brainstorming on columns, pagination, empty state, deletion).
- Stripe / paid tier — Plan 8.
- CSRF tokens on mutation routes — deferred (SameSite=Lax is good enough for the one mutation we add, logout).

## 2. Decisions locked in on 2026-04-19

| # | Decision | Choice | Why |
|---|---|---|---|
| P7-1 | Cookie architecture | Single cookie (`ggcookie`) upgraded to HMAC-signed; on verify, set `cookies.user_id` | A separate `ggsession` cookie only earns its keep when session lifetime differs from long-term identity, which it doesn't here. Folds in the production-checklist "cookie HMAC" item since we're already touching the cookie middleware. |
| P7-2 | Email provider | `Mailer` interface + `ConsoleMailer` only in Plan 7; real provider in Plan 10 | Provider pick is tangled with domain/DNS/DKIM, which belongs in deploy. Interface is the seam; the impl is cheap to swap. |
| P7-3 | Token lifecycle | Strict single-active: `POST /auth/magic` first invalidates prior unconsumed tokens for the same email | Eliminates "which link do I click?" confusion on re-request. One extra UPDATE before the INSERT. |
| P7-4 | Post-verify UX | Redirect to `/?verified=1` → landing page shows a 5s toast and strips the param | Clear "you're in" signal without preserve-intent plumbing (four touch points). Preserve-intent is a future polish. |
| P7-5 | Abuse protection on `/auth/magic` | Per-email (1/60s) + per-IP (5/10m), checked in that order | Two-level guard. Per-email stops inbox-spam; per-IP stops scripted attacker hitting many addresses. Same Redis sorted-set mechanism as grade rate-limit. |
| P7-6 | `/auth/verify` failure UX | Single param `?auth_error=expired_or_invalid` → landing renders one banner with "request a new link" CTA | Collapsed error case leaks nothing useful and avoids proliferating copy. |
| P7-7 | Plan 7 scope add-ons | Core + logout + resend-link button | Logout and resend are expected UX and tiny additions. `/my/grades` gets its own plan. |

## 3. Architecture

All Plan 7 code lives inside `src/server/`, `src/store/`, `src/mail/` (new), and `src/web/`. No top-level directory changes; no worker changes.

```
src/server/
├── app.ts                               MODIFY — mount /auth sub-app; auth routes DON'T inherit the /grades rate-limit
├── deps.ts                              MODIFY — add mailer: Mailer to ServerDeps
├── index.ts                             MODIFY — instantiate ConsoleMailer (or real Mailer if env var present)
├── middleware/
│   ├── cookie.ts                        MODIFY — HMAC-sign cookies, verify on read, grace-path for plain UUID
│   ├── bucket.ts                        NEW — generic peekBucket + addToBucket helpers (extracted from rate-limit.ts mechanism)
│   ├── rate-limit.ts                    MODIFY — refactor to call bucket.ts helpers (behavior unchanged)
│   └── auth-rate-limit.ts               NEW — checkMagicEmailBucket, checkMagicIpBucket
└── routes/
    └── auth.ts                          NEW — POST /auth/magic, GET /auth/verify, POST /auth/logout, GET /auth/me

src/mail/
├── types.ts                             NEW — Mailer interface + MagicLinkMessage type
└── console-mailer.ts                    NEW — logs URL to stdout

src/store/
├── types.ts                             MODIFY — add issueMagicToken, consumeMagicToken, unbindCookie, getCookieWithUser
└── postgres.ts                          MODIFY — implement the four new methods (all transactional)

src/config/
└── env.ts                               MODIFY — add COOKIE_HMAC_KEY and PUBLIC_BASE_URL (required in production)

src/web/
├── lib/
│   └── api.ts                           MODIFY — postAuthMagic, postAuthLogout, getAuthMe
├── hooks/
│   └── useAuth.ts                       NEW — wraps getAuthMe; exposes { verified, email, refresh, logout }
├── components/
│   ├── Header.tsx                       MODIFY — conditionally render "sign out" link when verified
│   └── Toast.tsx                        NEW — 5s auto-dismiss
├── pages/
│   ├── LandingPage.tsx                  MODIFY — read ?verified=1 (toast) and ?auth_error=... (banner); strip params
│   └── EmailGatePage.tsx                MODIFY — resend-link button with 60s cooldown countdown

.env.example                             MODIFY — document COOKIE_HMAC_KEY and PUBLIC_BASE_URL

tests/unit/server/
├── middleware/
│   ├── cookie.test.ts                   MODIFY — cover HMAC sign/verify, tamper rejection, plain-UUID grace
│   ├── bucket.test.ts                   NEW — pure bucket mechanics
│   └── auth-rate-limit.test.ts          NEW
└── routes/
    └── auth.test.ts                     NEW — happy + failure paths with FakeMailer + fake store

tests/unit/web/
├── hooks/
│   └── useAuth.test.tsx                 NEW
├── pages/
│   ├── LandingPage.test.tsx             MODIFY — add ?verified=1 toast + ?auth_error banner cases
│   └── EmailGatePage.test.tsx           MODIFY — add resend cooldown + 429 handling
└── components/
    └── Header.test.tsx                  MODIFY — sign-out link visibility

tests/unit/_helpers/
├── fake-store.ts                        MODIFY — add magic-token + user + unbind stubs
└── fake-mailer.ts                       NEW — memory-backed Mailer for route tests

tests/integration/
├── auth-magic-link.test.ts              NEW — full happy path: request → pluck token → verify → 4th grade allowed
├── auth-token-failures.test.ts          NEW — expired + already-consumed paths
└── auth-rate-limit.test.ts              NEW — per-email and per-IP buckets under real Redis
```

## 4. Cookie HMAC upgrade

### 4.1 Format

`ggcookie` value changes from `<uuid>` to `<uuid>.<hmac22>`, where `hmac22` is the first 22 base64url characters of `HMAC_SHA256(COOKIE_HMAC_KEY, uuid)`. 22 base64url chars = 132 bits, comfortably above collision resistance for a signing tag. The separating `.` is used as the split marker.

### 4.2 Middleware logic (revised `src/server/middleware/cookie.ts`)

On every request:

1. Read `ggcookie` header.
2. **Missing** → generate fresh UUID v4, upsert into `cookies` table, sign, set `Set-Cookie`, `c.set('cookie', uuid)`.
3. **Present, plain UUID** (no `.` in the value, valid UUIDv4 shape) → **grace path**: trust this one time, upsert into `cookies` (no-op if present), re-issue signed `Set-Cookie`, `c.set('cookie', uuid)`. Logged once per process with a `plain_uuid_cookie_migrated` tag so ops can see when the grace path goes cold.
4. **Present, signed shape** (`<something>.<something>`) → split on `.`, recompute HMAC of `uuid` part, `crypto.timingSafeEqual` against the hmac part. If mismatch, treat as forged → fresh cookie issued. (No explicit unbind: the fresh cookie has a new UUID, so any prior row keyed by the old UUID is unreferenced.) If match, `c.set('cookie', uuid)`.
5. **Present, malformed** (has `.` but split parts don't match expected shape) → fresh cookie issued.

The grace path is deliberately permanent. It's cheap, self-limiting (triggers only for the exact old format), and never creates new attack surface — someone who knows the victim's plain-UUID cookie already *has* the identity; re-signing doesn't grant new privileges.

### 4.3 Env var

`COOKIE_HMAC_KEY: z.string().min(32).optional()` in the Zod schema; required in `production` via `superRefine`. In dev/test, if unset, a module-level fallback constant (`"dev-insecure-hmac-key-do-not-use-in-prod-do-not-commit"`) is used with a one-time `console.warn` when the fallback is hit. This keeps the test suite and local dev zero-config while making prod misconfiguration loud.

### 4.4 Downstream API

Unchanged. `c.var.cookie` is still the raw UUID (same shape as before). Routes, rate-limit middleware, stores — nothing else needs to know the cookie is now signed.

## 5. `Mailer` interface

### 5.1 Interface (`src/mail/types.ts`)

```ts
export interface MagicLinkMessage {
  email: string        // already trimmed + lowercased by the route handler
  url: string          // fully-qualified https://host/auth/verify?t=<rawToken>
  expiresAt: Date      // 6h after issue, used in email copy
}

export interface Mailer {
  sendMagicLink(msg: MagicLinkMessage): Promise<void>
}
```

The interface is intentionally narrow. Future email types (receipt, report-ready) add *new methods* to the interface; the shape of each method stays focused.

### 5.2 `ConsoleMailer` (`src/mail/console-mailer.ts`)

Implements `sendMagicLink` by logging a visible banner to stdout containing email, expiry, and URL. No side effects beyond `console.log`. Used as the default `Mailer` binding for all non-production environments, and in production until `RESEND_API_KEY` (or equivalent) is set.

### 5.3 Dependency injection

`ServerDeps` gains a `mailer: Mailer` field. `src/server/index.ts` instantiates `new ConsoleMailer()` unconditionally in Plan 7. Plan 10 replaces this with an env-gated factory:

```ts
const mailer: Mailer = env.RESEND_API_KEY
  ? new ResendMailer({ apiKey: env.RESEND_API_KEY, fromAddress: env.MAIL_FROM })
  : new ConsoleMailer()
```

### 5.4 Tests

- Unit: `ConsoleMailer.sendMagicLink` — spy on `console.log`, assert email/url/expiry appear in output.
- Route tests: inject a `FakeMailer` (memory-backed `sent: MagicLinkMessage[]`) via `ServerDeps`; assertions read `mailer.sent[0].url`.

## 6. Auth endpoints

All four routes mount under `/auth` in `src/server/routes/auth.ts`. They inherit the cookie middleware (and thus `c.var.cookie`) but **not** the grade rate-limit (that's POST /grades-specific). The auth sub-app has its own rate-limit wiring for `/auth/magic`.

### 6.1 `POST /auth/magic`

**Request:** `{ email: string }`

**Validation:** `@hono/zod-validator` on body — `z.object({ email: z.string().email().trim().toLowerCase() })`. Malformed → `400 { error: 'invalid_email' }`.

**Rate-limit (peek both, then add both on pass):**

1. `peekBucket(redis, { key: 'magic:email:<email>', limit: 1, windowMs: 60_000 })` — if denied: `429 { paywall: 'email_cooldown', limit, used, retryAfter }`.
2. `peekBucket(redis, { key: 'magic:ip:<ip>', limit: 5, windowMs: 600_000 })` — if denied: `429 { paywall: 'ip_cooldown', limit, used, retryAfter }`.
3. Both pass: `addToBucket` for each. (Non-atomic; documented on the production checklist.)

**Main flow:**

1. `{ rawToken, expiresAt } = await store.issueMagicToken(email, c.var.cookie)`.
2. `url = \`${env.PUBLIC_BASE_URL}/auth/verify?t=${rawToken}\``.
3. `await mailer.sendMagicLink({ email, url, expiresAt })`.
4. Respond `204 No Content`.

**Success response is always 204.** No body. Future-proofs against email enumeration even though we currently auto-create users (enumeration isn't a problem *today*, but could become one if we ever add "account already exists" semantics).

**`store.issueMagicToken(email, issuingCookie)` semantics** (transaction):

```sql
UPDATE magic_tokens SET consumed_at = now()
  WHERE email = $1 AND consumed_at IS NULL;           -- invalidate priors
-- generate 32 random bytes → rawToken (base64url encoded)
-- tokenHash = sha256(rawToken) hex
INSERT INTO magic_tokens (email, token_hash, expires_at, cookie)
  VALUES ($1, $hash, now() + interval '6 hours', $cookie)
  RETURNING expires_at;
-- returns { rawToken, expiresAt } to the handler
```

### 6.2 `GET /auth/verify?t=<rawToken>`

**Validation:** `t` query param present, non-empty, matches base64url alphabet. Missing/malformed → `302 → /?auth_error=expired_or_invalid`.

**Flow:**

1. `tokenHash = sha256(t)`.
2. `result = await store.consumeMagicToken(tokenHash, c.var.cookie)`.
3. On `{ ok: false }`: `302 → /?auth_error=expired_or_invalid`.
4. On `{ ok: true, email, userId }`: `302 → /?verified=1`.

**`store.consumeMagicToken(tokenHash, clickingCookie)` semantics** (transaction):

```sql
SELECT id, email, expires_at, consumed_at
  FROM magic_tokens WHERE token_hash = $1
  FOR UPDATE;
-- if NOT FOUND, or consumed_at IS NOT NULL, or expires_at < now() → ROLLBACK, return { ok: false }

INSERT INTO users (email) VALUES ($email)
  ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
  RETURNING id;                                        -- returns existing id on conflict

UPDATE cookies SET user_id = $userId
  WHERE cookie = $clickingCookie;

UPDATE magic_tokens SET consumed_at = now() WHERE id = $tokenId;
-- return { ok: true, email, userId }
```

**Note on binding:** `magic_tokens.cookie` (the *issuing* cookie) is **not** used for binding — it's stored as an audit trail. The *clicking* request's cookie (the browser that demonstrated inbox access) is the only thing bound. This prevents "request from kiosk, click from home → kiosk becomes verified" attacks.

### 6.3 `POST /auth/logout`

Body-less POST.

1. `await store.unbindCookie(c.var.cookie)` → `UPDATE cookies SET user_id = NULL WHERE cookie = $1`.
2. Respond `204 No Content`.

Cookie itself stays. User becomes anonymous again, inheriting their pre-verification rate-limit bucket (which is probably full, since they only verified to get past it — that's fine, the UX is "sign out is a cosmetic action while in this browser session").

No CSRF token. SameSite=Lax on `ggcookie` defends against cross-site form POSTs in all modern browsers. Worst case of an unprotected logout: a CSRF attack forcibly signs out a user, which is a nuisance not a compromise. CSRF tokens land when we add a mutation that matters (delete-grade, profile-edit, future plans).

### 6.4 `GET /auth/me`

Reads `cookies.user_id` for `c.var.cookie`. If non-null, joins `users` and returns `{ verified: true, email }`. Else returns `{ verified: false }`. No caching headers (state is per-request trivial).

Used by frontend `useAuth` hook on initial mount so the header can conditionally show "sign out" and landing-page copy can reflect signed-in state.

## 7. Auth rate-limiting

### 7.1 Refactor: extract `src/server/middleware/bucket.ts`

The mechanism inside `checkRateLimit` (Plan 6a) is grade-specific only in its key. Extract it:

```ts
export interface BucketConfig { key: string; limit: number; windowMs: number }
export interface BucketResult { allowed: boolean; limit: number; used: number; retryAfter: number }

// Performs ZREMRANGEBYSCORE + ZCARD; returns would-be-allowed result without mutating.
export async function peekBucket(redis: Redis, cfg: BucketConfig, now: number): Promise<BucketResult>

// Performs ZADD + EXPIRE.
export async function addToBucket(redis: Redis, cfg: BucketConfig, now: number): Promise<void>
```

`peekBucket` uses the same half-open window semantics as Plan 6a (`cutoff - 1` boundary). `addToBucket` uses `${now}-${crypto.randomUUID()}` as the member value. Both EXPIRE the key at `windowMs / 1000` rounded up.

`src/server/middleware/rate-limit.ts` (grade) is refactored to call these; external behavior is unchanged. Unit tests stay green with no edits (the existing tests hit the public function).

### 7.2 `src/server/middleware/auth-rate-limit.ts`

Thin wrappers over `bucket.ts`:

```ts
export async function checkMagicEmailBucket(redis: Redis, email: string, now: number): Promise<BucketResult>
export async function checkMagicIpBucket(redis: Redis, ip: string, now: number): Promise<BucketResult>

// "peek" variants for the route handler to call before addToBucket
export async function peekMagicEmailBucket(redis: Redis, email: string, now: number): Promise<BucketResult>
export async function peekMagicIpBucket(redis: Redis, ip: string, now: number): Promise<BucketResult>
```

Configs:
- Email bucket: `key = magic:email:<email>`, `limit = 1`, `windowMs = 60_000`.
- IP bucket: `key = magic:ip:<ip>`, `limit = 5`, `windowMs = 600_000`.

The `POST /auth/magic` handler calls `peekMagicEmailBucket` first, then `peekMagicIpBucket`; on both pass, calls both `addToBucket`s. (Email first in error ordering — see Q5 rationale.)

### 7.3 Atomicity

Peek-then-add is **not** atomic across concurrent requests. Two simultaneous requests from the same IP with the same email could both peek-allowed and both add. Impact is bounded: one extra email sent per race window. Mitigation is a Lua-scripted combined peek-add, which is **deferred to the production checklist** as an extension of the existing rate-limit atomicity item.

## 8. Store methods

Four additions to `GradeStore` (`src/store/types.ts`). All transactional in `PostgresStore`.

```ts
interface GradeStore {
  // ...existing...

  issueMagicToken(email: string, issuingCookie: string): Promise<{ rawToken: string; expiresAt: Date }>
  consumeMagicToken(tokenHash: string, clickingCookie: string): Promise<
    | { ok: true; email: string; userId: string }
    | { ok: false }
  >
  unbindCookie(cookie: string): Promise<void>
  getCookieWithUser(cookie: string): Promise<{ cookie: string; userId: string | null; email: string | null }>
}
```

`getCookieWithUser` is used by `GET /auth/me`. The existing `getCookie` stays as-is (still used by rate-limit middleware and other non-email-aware code paths).

`FakeStore` (tests) gets matching memory-backed stubs: a `Map<hash, MagicTokenRow>`, a `Map<email, UserRow>`, and the existing cookies Map is extended to track `userId`.

## 9. Frontend changes

### 9.1 `src/web/lib/api.ts` (additions)

```ts
type MagicResult =
  | { ok: true }
  | { ok: false; error: 'invalid_email' | 'rate_limit_email' | 'rate_limit_ip'; retryAfter?: number }

export async function postAuthMagic(email: string): Promise<MagicResult>
export async function postAuthLogout(): Promise<void>
export async function getAuthMe(): Promise<{ verified: boolean; email?: string }>
```

All use `credentials: 'include'`. `postAuthMagic` distinguishes 400 vs the two 429 paywall shapes by reading the response body.

### 9.2 `src/web/hooks/useAuth.ts` (new)

Returns `{ verified: boolean; email: string | null; refresh: () => Promise<void>; logout: () => Promise<void> }`. Calls `getAuthMe()` on mount; `logout` calls `postAuthLogout` then `refresh`. Exposed via React context provider wrapped around `<App />` root. Components `useAuth()` as needed.

### 9.3 `EmailGatePage` — resend-link flow

State: `{ pending, sent, error, cooldownUntil }`. After a successful submit, `sent = true` and `cooldownUntil = Date.now() + 60_000`. UI renders a "resend link" button that is disabled with a live countdown ("resend in 42s") until cooldown passes. Clicking it re-calls `postAuthMagic`. On 429, update `cooldownUntil` from the server's `retryAfter` (accommodates clock drift).

Error copy:
- `invalid_email` → inline "That doesn't look like a valid email."
- `rate_limit_email` → inline "Please wait {retryAfter}s before resending."
- `rate_limit_ip` → inline "Too many requests from this connection. Try again in {Math.ceil(retryAfter/60)}m."

### 9.4 `LandingPage` — toast + banner

On mount:
- `?verified=1` → render `<Toast>` for 5s ("You're in — 10 more grades in this 24h window."), then `history.replaceState(null, '', '/')` to strip the param.
- `?auth_error=expired_or_invalid` → render a persistent banner ("Your sign-in link didn't work. Request a new one.") with a button linking to `/email`. Banner dismisses via X button, which also strips the param.

### 9.5 `Toast.tsx` (new component)

Bottom-right fixed position. Accepts `{ message: string; durationMs?: number; onDismiss: () => void }`. Auto-dismisses via `setTimeout` in a `useEffect`. Keyed on `message` so re-renders with the same message don't reset the timer unexpectedly.

### 9.6 `Header` — sign-out link

If `useAuth().verified`, render a muted "sign out" link on the right of the header. Click → `logout()` → on resolve, re-render (verified is now false). No post-logout toast — the link disappearing is its own confirmation; keeps the header lean.

## 10. Data model

No schema changes. Plan 7 only starts writing rows to tables that Plan 1 already created.

**Tables touched:**
- `users` — Plan 7 is the first writer. Rows created on successful `/auth/verify`.
- `cookies` — Plan 7 starts setting `user_id` (was NULL until now).
- `magic_tokens` — Plan 7 is the first writer. Rows written on `/auth/magic`, marked consumed on `/auth/verify`.

**Indexes:** the existing schema has a unique index on `magic_tokens.token_hash` (already in Plan 1). No new indexes needed for Plan 7. The anticipated query `WHERE email = $1 AND consumed_at IS NULL` on the invalidation step is small-cardinality (one active token per email at any time after Plan 7 ships); no index required for MVP scale.

## 11. Env vars

### 11.1 New entries in `src/config/env.ts`

```ts
COOKIE_HMAC_KEY: z.string().min(32).optional()
PUBLIC_BASE_URL: z.string().url().optional()
```

Both added to the `production` required list in `superRefine`.

### 11.2 Dev fallbacks

- `COOKIE_HMAC_KEY` → `"dev-insecure-hmac-key-do-not-use-in-prod-do-not-commit"` when unset in dev/test. Warn-once.
- `PUBLIC_BASE_URL` → `"http://localhost:5173"` when unset in dev/test. Warn-once.

### 11.3 `.env.example`

Adds documented (but commented out) examples for both vars, noting they're required in production and what the dev fallbacks are.

## 12. Testing

### 12.1 Unit — pure functions

- `signCookie`, `verifyCookie`, `parseCookie` — round-trip, tamper detection, malformed inputs, timing-safe compare via boolean output.
- `hashToken` — deterministic, correct hex length.
- `peekBucket` / `addToBucket` mechanics — edge of window, retryAfter math, separate buckets don't leak into each other.

### 12.2 Unit — middleware

- `cookie.ts`: fresh-issue path, valid-signed path, tamper-rejection path, plain-UUID grace path. Stub `GradeStore` via `FakeStore`.
- `auth-rate-limit.ts`: per-email deny, per-IP deny, order-of-denial correctness.

### 12.3 Unit — routes (`tests/unit/server/routes/auth.test.ts`)

All tests use `app.fetch(new Request(...))` with a fake `ServerDeps` (FakeStore, FakeMailer, ioredis-mock or testcontainers-Redis).

- `POST /auth/magic` — happy: 204 + FakeMailer received URL containing a base64url token.
- `POST /auth/magic` — invalid email: 400.
- `POST /auth/magic` — second call within 60s: 429 with `paywall: 'email_cooldown'`.
- `POST /auth/magic` — 6th call from same IP within 10m: 429 with `paywall: 'ip_cooldown'`.
- `POST /auth/magic` — invalidates prior tokens: request twice, try to verify the first link → fails.
- `GET /auth/verify` — happy: 302 to `/?verified=1`, cookies row has user_id.
- `GET /auth/verify` — expired token: 302 to `/?auth_error=...`.
- `GET /auth/verify` — already-consumed token: 302 to `/?auth_error=...`.
- `GET /auth/verify` — missing/malformed `t`: 302 to `/?auth_error=...`.
- `GET /auth/verify` — clicking cookie binding: verify from a different cookie than the one that requested; only the clicking cookie gets user_id set.
- `POST /auth/logout` — 204, cookies.user_id → NULL.
- `GET /auth/me` — unverified: `{ verified: false }`. Verified: `{ verified: true, email }`.

### 12.4 Integration (real Postgres + Redis via testcontainers)

- `tests/integration/auth-magic-link.test.ts` — full happy path. Consume 3 grades anonymously, hit the 4th (expect 429 with `paywall: 'email'`), POST /auth/magic, pluck the raw token out of FakeMailer, GET /auth/verify, POST the 4th grade again, expect 202.
- `tests/integration/auth-token-failures.test.ts` — expired and double-use (the specific paths that involve a round-trip through Postgres: first consume succeeds, second attempt with the same token fails).
- `tests/integration/auth-rate-limit.test.ts` — email and IP buckets under real Redis, including retryAfter accuracy across the window boundary.

### 12.5 Frontend (RTL)

- `LandingPage` with `?verified=1` → toast visible, fake timer advance 5s → toast gone, URL stripped.
- `LandingPage` with `?auth_error=expired_or_invalid` → banner visible, click "request new link" navigates to `/email`.
- `EmailGatePage` resend flow — submit, advance fake timer (59s → button disabled with countdown, 61s → button enabled), click resend, second `postAuthMagic` call observed.
- `EmailGatePage` 429 handling — mock `postAuthMagic` to return `{ ok: false, error: 'rate_limit_email', retryAfter: 42 }`, assert inline error + countdown starts from 42s.
- `Header` sign-out link — renders when `useAuth` returns `verified: true`; click calls `logout`.
- `useAuth` hook — `getAuthMe` mocked, state reflects response.

**Targets:** ~25 new unit tests, 3 new integration tests, 6 new frontend tests. Project totals after Plan 7: ~340 unit, ~38 integration.

## 13. Production checklist diff

### 13.1 Closed by Plan 7

- **Cookie signing (HMAC).** Shipped as part of Plan 7's cookie middleware upgrade. Checklist entry removed on merge.

### 13.2 Added by Plan 7

- **Atomic rate-limit for `/auth/magic`.** Same Lua-script fix as the grade bucket's atomicity item; add as extension of the existing entry or as a parallel entry.
- **CSRF tokens on mutation routes.** Plan 7 adds exactly one mutation (logout) without CSRF protection, relying on SameSite=Lax. When Plan 8/9+ add delete-grade or profile mutations, proper CSRF tokens land.
- **Real email provider + DKIM/SPF/DMARC.** Plan 7 ships ConsoleMailer only. Provider selection + DNS records + RealMailer impl land in Plan 10.
- **Magic-link device-scoped verification (optional hardening).** Current behavior binds the clicking cookie regardless of issuing cookie. A stricter mode requires the clicking browser to present the same cookie as the one that issued the link; trade-off worth revisiting post-launch.

### 13.3 Unchanged

All other Security, Reliability/ops, Data/correctness, UX/product, Deploy/ops, and Dev UX items remain as-is.

## 14. Master-spec anchor

Plan 7 extends master spec §7.2 (email tier). After merge, master spec gets a short anchor paragraph pointing to this sub-spec, consistent with how §11 points at Plan 6b.

---

**Open points at spec-write time (none expected to change the design):**
- Toast visual treatment (color, animation) — absorbed by existing terminal aesthetic; no new tokens.
- Email copy for the magic link URL — ConsoleMailer doesn't need it; real provider will need a template, which Plan 10 owns.
