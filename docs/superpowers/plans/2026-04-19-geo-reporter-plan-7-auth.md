# GEO Reporter Plan 7 — Magic-Link Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the anonymous rate-limit ceiling liftable via email magic link: visitor hits `/email`, types address, clicks emailed link, becomes verified (13/24h quota). Also: HMAC-sign the anonymous cookie, ship a pluggable `Mailer` seam with `ConsoleMailer`, and surface verified state in the UI.

**Architecture:** Four auth routes (`/auth/magic`, `/auth/verify`, `/auth/logout`, `/auth/me`) backed by four new store methods (magic-token issue/consume, cookie unbind, cookie-with-user read). Cookie middleware upgrades from plain UUID to `<uuid>.<hmac>` with a permanent grace path for old plain-UUID cookies. Rate-limit mechanism extracted into a generic `bucket.ts` so the grade bucket and two new auth buckets (per-email 1/60s, per-IP 5/10m) share one implementation. Frontend adds a `useAuth` hook, a Toast component, landing-page toast/banner handling, resend-link cooldown UI on `EmailGatePage`, and a sign-out link on `Header`.

**Tech Stack:** TypeScript 5.6+ strict, Hono 4, Node `crypto` (HMAC-SHA256 + timingSafeEqual), vitest 2 + testcontainers 10, React 18 + React Testing Library + happy-dom. No new runtime deps.

---

## Spec references

- Sub-spec (source of truth): `docs/superpowers/specs/2026-04-19-geo-reporter-plan-7-auth-design.md`
- Master spec: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` §7.2 (email tier / magic-link).

**Interpretation calls locked in (sub-spec §2, brainstormed 2026-04-19):**

- P7-1: Single cookie (`ggcookie`) upgraded to `<uuid>.<hmac>`; verify binding sets `cookies.user_id`.
- P7-2: Plan 7 ships `Mailer` interface + `ConsoleMailer` only. Real provider (Resend/Postmark) is a Plan 10 concern.
- P7-3: Strict single-active tokens — `POST /auth/magic` invalidates prior unconsumed tokens for that email before issuing.
- P7-4: Post-verify → `302 /?verified=1`; landing page shows 5s toast and strips the param.
- P7-5: Two-level rate-limit on `/auth/magic`: per-email 1/60s + per-IP 5/10m. Check email first.
- P7-6: Verify failures (expired / invalid / consumed) collapse to `302 /?auth_error=expired_or_invalid`.
- P7-7: Scope = core flow + logout + resend-link. No `/my/grades` page (separate plan).

---

## File structure

```
src/server/
├── app.ts                                MODIFY — mount /auth sub-app (no rate-limit inheritance)
├── deps.ts                               MODIFY — add mailer: Mailer
├── server.ts                             MODIFY — instantiate ConsoleMailer; pass into deps
├── middleware/
│   ├── cookie.ts                         MODIFY — HMAC sign/verify + grace path for plain UUID
│   ├── cookie-sign.ts                    NEW — pure signCookie/verifyCookie/parseCookie
│   ├── bucket.ts                         NEW — generic peekBucket + addToBucket
│   ├── rate-limit.ts                     MODIFY — refactor to call bucket.ts
│   └── auth-rate-limit.ts                NEW — peek/add wrappers for email + IP buckets
└── routes/
    └── auth.ts                           NEW — 4 auth routes

src/mail/
├── types.ts                              NEW — Mailer interface + MagicLinkMessage type
└── console-mailer.ts                     NEW — logs URL to stdout

src/store/
├── types.ts                              MODIFY — add 4 methods
└── postgres.ts                           MODIFY — implement 4 methods (transactional)

src/config/
└── env.ts                                MODIFY — add COOKIE_HMAC_KEY + PUBLIC_BASE_URL (required in prod)

src/web/
├── lib/
│   └── api.ts                            MODIFY — postAuthMagic, postAuthLogout, getAuthMe
├── hooks/
│   └── useAuth.ts                        NEW — wraps getAuthMe; exposes { verified, email, refresh, logout }
├── components/
│   ├── Header.tsx                        MODIFY — sign-out link when verified
│   └── Toast.tsx                         NEW — 5s auto-dismiss
└── pages/
    ├── LandingPage.tsx                   MODIFY — verified=1 toast + auth_error banner; strip params
    └── EmailGatePage.tsx                 MODIFY — resend-link button with 60s cooldown

.env.example                              MODIFY — document COOKIE_HMAC_KEY + PUBLIC_BASE_URL

tests/unit/_helpers/
├── fake-store.ts                         MODIFY — magic-token + user-bind + unbind stubs
└── fake-mailer.ts                        NEW — memory-backed Mailer for route tests

tests/unit/server/
├── middleware/
│   ├── cookie.test.ts                    MODIFY — HMAC paths + grace path
│   ├── cookie-sign.test.ts               NEW — pure functions
│   ├── bucket.test.ts                    NEW — peek/add mechanics
│   └── auth-rate-limit.test.ts           NEW
├── routes/
│   └── auth.test.ts                      NEW — all four routes via app.fetch
└── mail/
    └── console-mailer.test.ts            NEW

tests/unit/store/
├── fake-store-magic.test.ts              NEW — fake store magic-token semantics
└── fake-store-unbind.test.ts             NEW — fake store unbind + getCookieWithUser

tests/unit/web/
├── hooks/
│   └── useAuth.test.tsx                  NEW
├── components/
│   ├── Toast.test.tsx                    NEW
│   └── Header.test.tsx                   MODIFY — sign-out link
└── pages/
    ├── LandingPage.test.tsx              MODIFY — toast + banner paths
    └── EmailGatePage.test.tsx            MODIFY — resend cooldown + 429 handling

tests/integration/
├── auth-magic-link.test.ts               NEW — full happy path
├── auth-token-failures.test.ts           NEW — expired + double-consume
└── auth-rate-limit.test.ts               NEW — email + IP buckets under real Redis

docs/
└── production-checklist.md               MODIFY — remove cookie-HMAC; add 4 new deferred items

docs/superpowers/specs/
└── 2026-04-17-geo-reporter-design.md     MODIFY — anchor paragraph pointing at Plan 7 sub-spec
```

---

## Project constraints (from CLAUDE.md)

- `.ts` extensions on ALL imports (Node ESM requirement).
- `import type` for type-only imports (`verbatimModuleSyntax: true`).
- `exactOptionalPropertyTypes: true` — conditionally spread optional fields rather than assigning `undefined`.
- Git commits: inline identity only, never touch global config:
  ```
  git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit ...
  ```
- Store access goes through `GradeStore`; `PostgresStore` is the only impl; do not `import { db }` in feature code.
- Test discipline: TDD. Unit tests use `app.fetch(new Request(...))` + fakes; integration tests use testcontainers Postgres + Redis.

---

## Task 1: Cookie signing pure functions

**Files:**
- Create: `src/server/middleware/cookie-sign.ts`
- Test: `tests/unit/server/middleware/cookie-sign.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server/middleware/cookie-sign.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { signCookie, verifyCookie, parseCookie } from '../../../../src/server/middleware/cookie-sign.ts'

const KEY = 'test-key-exactly-32-chars-long-aa'
const UUID = '1b671a64-40d5-491e-99b0-da01ff1f3341'

describe('cookie-sign', () => {
  it('signs then verifies a uuid', () => {
    const signed = signCookie(UUID, KEY)
    expect(signed.startsWith(`${UUID}.`)).toBe(true)
    expect(signed.length).toBe(UUID.length + 1 + 22)
    expect(verifyCookie(signed, KEY)).toBe(UUID)
  })

  it('rejects tampered uuid', () => {
    const signed = signCookie(UUID, KEY)
    const otherUuid = '2b671a64-40d5-491e-99b0-da01ff1f3341'
    const tampered = `${otherUuid}.${signed.split('.')[1]}`
    expect(verifyCookie(tampered, KEY)).toBe(null)
  })

  it('rejects tampered hmac', () => {
    const signed = signCookie(UUID, KEY)
    const tampered = `${UUID}.AAAAAAAAAAAAAAAAAAAAAA`
    expect(verifyCookie(tampered, KEY)).toBe(null)
  })

  it('rejects different key', () => {
    const signed = signCookie(UUID, KEY)
    expect(verifyCookie(signed, 'different-key-exactly-32-chars-bb')).toBe(null)
  })

  it('parseCookie returns plain-uuid shape for unsigned input', () => {
    expect(parseCookie(UUID)).toEqual({ kind: 'plain', uuid: UUID })
  })

  it('parseCookie returns signed shape for signed input', () => {
    const signed = signCookie(UUID, KEY)
    expect(parseCookie(signed)).toEqual({ kind: 'signed', uuid: UUID, hmac: signed.split('.')[1] })
  })

  it('parseCookie returns malformed for garbage', () => {
    expect(parseCookie('')).toEqual({ kind: 'malformed' })
    expect(parseCookie('not-a-uuid')).toEqual({ kind: 'malformed' })
    expect(parseCookie('a.b.c')).toEqual({ kind: 'malformed' })
    expect(parseCookie(`${UUID}.`)).toEqual({ kind: 'malformed' })
  })

  it('parseCookie returns malformed for non-uuid in signed shape', () => {
    expect(parseCookie('not-a-uuid.AAAAAAAAAAAAAAAAAAAAAA')).toEqual({ kind: 'malformed' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/server/middleware/cookie-sign.test.ts`
Expected: FAIL — file `cookie-sign.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/server/middleware/cookie-sign.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HMAC_CHARS = 22

export type ParsedCookie =
  | { kind: 'plain'; uuid: string }
  | { kind: 'signed'; uuid: string; hmac: string }
  | { kind: 'malformed' }

function hmacFor(uuid: string, key: string): string {
  return createHmac('sha256', key).update(uuid).digest('base64url').slice(0, HMAC_CHARS)
}

export function signCookie(uuid: string, key: string): string {
  return `${uuid}.${hmacFor(uuid, key)}`
}

export function verifyCookie(raw: string, key: string): string | null {
  const parts = raw.split('.')
  if (parts.length !== 2) return null
  const [uuid, hmac] = parts
  if (!uuid || !hmac || !UUID_V4_REGEX.test(uuid) || hmac.length !== HMAC_CHARS) return null
  const expected = hmacFor(uuid, key)
  const a = Buffer.from(expected)
  const b = Buffer.from(hmac)
  if (a.length !== b.length) return null
  return timingSafeEqual(a, b) ? uuid : null
}

export function parseCookie(raw: string): ParsedCookie {
  if (!raw) return { kind: 'malformed' }
  if (UUID_V4_REGEX.test(raw)) return { kind: 'plain', uuid: raw }
  const parts = raw.split('.')
  if (parts.length !== 2) return { kind: 'malformed' }
  const [uuid, hmac] = parts
  if (!uuid || !hmac || !UUID_V4_REGEX.test(uuid) || hmac.length !== HMAC_CHARS) {
    return { kind: 'malformed' }
  }
  return { kind: 'signed', uuid, hmac }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/unit/server/middleware/cookie-sign.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/cookie-sign.ts tests/unit/server/middleware/cookie-sign.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): add HMAC cookie sign/verify pure functions"
```

---

## Task 2: Env var additions (COOKIE_HMAC_KEY, PUBLIC_BASE_URL)

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Test: `tests/unit/config/env.test.ts` (existing file — add cases)

- [ ] **Step 1: Write the failing test cases**

Append to `tests/unit/config/env.test.ts`:

```ts
describe('env — Plan 7 auth vars', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o',
    GEMINI_API_KEY: 'sk-g', PERPLEXITY_API_KEY: 'sk-p',
  }

  it('accepts missing COOKIE_HMAC_KEY in development', () => {
    const result = loadEnv({ ...base, NODE_ENV: 'development' })
    expect(result.COOKIE_HMAC_KEY).toBeUndefined()
    expect(result.PUBLIC_BASE_URL).toBeUndefined()
  })

  it('accepts COOKIE_HMAC_KEY at 32 chars', () => {
    const key = 'a'.repeat(32)
    const result = loadEnv({ ...base, NODE_ENV: 'development', COOKIE_HMAC_KEY: key })
    expect(result.COOKIE_HMAC_KEY).toBe(key)
  })

  it('rejects COOKIE_HMAC_KEY shorter than 32 chars', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', COOKIE_HMAC_KEY: 'short' })).toThrow(/COOKIE_HMAC_KEY/)
  })

  it('requires COOKIE_HMAC_KEY in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/COOKIE_HMAC_KEY/)
  })

  it('requires PUBLIC_BASE_URL in production', () => {
    expect(() => loadEnv({
      ...base, NODE_ENV: 'production',
      COOKIE_HMAC_KEY: 'a'.repeat(32),
    })).toThrow(/PUBLIC_BASE_URL/)
  })

  it('rejects non-URL PUBLIC_BASE_URL', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', PUBLIC_BASE_URL: 'not a url' })).toThrow(/PUBLIC_BASE_URL/)
  })

  it('accepts fully-configured production env', () => {
    const env = loadEnv({
      ...base, NODE_ENV: 'production',
      COOKIE_HMAC_KEY: 'a'.repeat(32),
      PUBLIC_BASE_URL: 'https://geo-reporter.com',
    })
    expect(env.PUBLIC_BASE_URL).toBe('https://geo-reporter.com')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/config/env.test.ts`
Expected: FAIL — schema doesn't know about `COOKIE_HMAC_KEY` or `PUBLIC_BASE_URL`.

- [ ] **Step 3: Extend the schema**

Modify `src/config/env.ts`. Inside the `z.object({...})` block, add the two new fields:

```ts
COOKIE_HMAC_KEY: z.string().min(32).optional(),
PUBLIC_BASE_URL: z.string().url().optional(),
```

Inside the `superRefine` block, extend `required` to include the two new keys:

```ts
const required = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY',
  'COOKIE_HMAC_KEY', 'PUBLIC_BASE_URL',
] as const
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/unit/config/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Update .env.example**

Append to `.env.example`:

```
# Plan 7 — auth
# COOKIE_HMAC_KEY: HMAC key for signing the anonymous ggcookie. Required in
# production; min 32 chars. In dev, falls back to an insecure built-in default
# with a one-time warning.
# COOKIE_HMAC_KEY=

# PUBLIC_BASE_URL: The public origin of the site, used to build magic-link URLs
# inside emails. Required in production. In dev, falls back to
# http://localhost:5173 (Vite's dev URL) with a one-time warning.
# PUBLIC_BASE_URL=
```

- [ ] **Step 6: Run full unit suite to catch any spillover**

Run: `pnpm test`
Expected: PASS (all existing tests; plus the 7 new env tests).

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts tests/unit/config/env.test.ts .env.example
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): add COOKIE_HMAC_KEY and PUBLIC_BASE_URL env vars"
```

---

## Task 3: Cookie middleware HMAC upgrade + grace path

**Files:**
- Modify: `src/server/middleware/cookie.ts`
- Modify: `tests/unit/server/middleware/cookie.test.ts`

- [ ] **Step 1: Add new test cases**

The existing `cookie.test.ts` covers the Plan 6a behavior (fresh-issue on missing cookie). Keep those; add these new cases:

```ts
import { signCookie } from '../../../../src/server/middleware/cookie-sign.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

describe('cookie middleware — Plan 7 HMAC', () => {
  it('accepts a validly signed cookie unchanged', async () => {
    const uuid = crypto.randomUUID()
    const signed = signCookie(uuid, HMAC_KEY)
    const store = makeFakeStore()
    await store.upsertCookie(uuid)
    const app = buildTestApp(store, HMAC_KEY)
    const res = await app.fetch(new Request('http://test/', { headers: { cookie: `ggcookie=${signed}` } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull() // no re-issue
    const body = await res.json()
    expect(body.cookie).toBe(uuid)
  })

  it('rejects tampered signature and issues a fresh cookie', async () => {
    const uuid = crypto.randomUUID()
    const store = makeFakeStore()
    const app = buildTestApp(store, HMAC_KEY)
    const tampered = `${uuid}.AAAAAAAAAAAAAAAAAAAAAA`
    const res = await app.fetch(new Request('http://test/', { headers: { cookie: `ggcookie=${tampered}` } }))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('ggcookie=')
    const newRaw = setCookie!.split('ggcookie=')[1]!.split(';')[0]
    const body = await res.json()
    expect(body.cookie).not.toBe(uuid) // fresh uuid; old one was rejected
    expect(newRaw).toContain('.') // new cookie is signed
  })

  it('grace path: accepts a plain UUID cookie and re-signs it', async () => {
    const uuid = crypto.randomUUID()
    const store = makeFakeStore()
    await store.upsertCookie(uuid)
    const app = buildTestApp(store, HMAC_KEY)
    const res = await app.fetch(new Request('http://test/', { headers: { cookie: `ggcookie=${uuid}` } }))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('ggcookie=')
    const newRaw = setCookie!.split('ggcookie=')[1]!.split(';')[0]
    expect(newRaw).toBe(signCookie(uuid, HMAC_KEY))
    const body = await res.json()
    expect(body.cookie).toBe(uuid) // same uuid preserved
  })

  it('malformed cookie triggers fresh issuance', async () => {
    const store = makeFakeStore()
    const app = buildTestApp(store, HMAC_KEY)
    const res = await app.fetch(new Request('http://test/', { headers: { cookie: 'ggcookie=garbage' } }))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('ggcookie=')
  })
})
```

Also update the `buildTestApp` helper at the top of the file to accept `hmacKey`:

```ts
function buildTestApp(store: FakeGradeStore, hmacKey: string = HMAC_KEY): Hono {
  const app = new Hono<{ Variables: { cookie: string } }>()
  app.use('*', cookieMiddleware(store, false, hmacKey))
  app.get('/', (c) => c.json({ cookie: c.var.cookie }))
  return app
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/server/middleware/cookie.test.ts`
Expected: FAIL — `cookieMiddleware` doesn't accept an HMAC key; grace path doesn't exist.

- [ ] **Step 3: Update cookie middleware**

Replace `src/server/middleware/cookie.ts` with:

```ts
import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { GradeStore } from '../../store/types.ts'
import { parseCookie, signCookie, verifyCookie } from './cookie-sign.ts'

export const COOKIE_NAME = 'ggcookie'
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

type Env = { Variables: { cookie: string } }

let graceWarned = false

function issueFresh(c: Parameters<MiddlewareHandler<Env>>[0], store: GradeStore, hmacKey: string, isProduction: boolean): string {
  const uuid = crypto.randomUUID()
  const signed = signCookie(uuid, hmacKey)
  setCookie(c, COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  })
  void store.upsertCookie(uuid)
  return uuid
}

function reIssueSigned(c: Parameters<MiddlewareHandler<Env>>[0], uuid: string, hmacKey: string, isProduction: boolean): void {
  const signed = signCookie(uuid, hmacKey)
  setCookie(c, COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  })
}

export function cookieMiddleware(store: GradeStore, isProduction: boolean, hmacKey: string): MiddlewareHandler<Env> {
  return async (c, next) => {
    const raw = getCookie(c, COOKIE_NAME)
    let uuid: string

    if (!raw) {
      uuid = issueFresh(c, store, hmacKey, isProduction)
    } else {
      const parsed = parseCookie(raw)
      if (parsed.kind === 'plain') {
        if (!graceWarned) {
          console.log(JSON.stringify({ msg: 'cookie_grace_path: accepted plain uuid, re-signed', tag: 'plain_uuid_cookie_migrated' }))
          graceWarned = true
        }
        await store.upsertCookie(parsed.uuid)
        reIssueSigned(c, parsed.uuid, hmacKey, isProduction)
        uuid = parsed.uuid
      } else if (parsed.kind === 'signed') {
        const verified = verifyCookie(raw, hmacKey)
        if (verified) {
          uuid = verified
        } else {
          uuid = issueFresh(c, store, hmacKey, isProduction)
        }
      } else {
        uuid = issueFresh(c, store, hmacKey, isProduction)
      }
    }

    c.set('cookie', uuid)
    await next()
  }
}
```

- [ ] **Step 4: Update the call site chain so tests compile**

Three files need updates — all minimal, and they go together because `ServerDeps.env` and its consumers are coupled.

**`src/server/deps.ts`** — extend the `env` field to include `COOKIE_HMAC_KEY`:

```ts
import type Redis from 'ioredis'
import type { GradeStore } from '../store/types.ts'

export interface ServerDeps {
  store: GradeStore
  redis: Redis
  redisFactory: () => Redis
  pingDb: () => Promise<boolean>
  pingRedis: () => Promise<boolean>
  env: { NODE_ENV: 'development' | 'test' | 'production'; COOKIE_HMAC_KEY: string }
}
```

**`src/server/app.ts`** — change the `cookieMiddleware(...)` call to pass the HMAC key. Replace:

```ts
gradeScope.use('*', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production'))
```

with:

```ts
gradeScope.use('*', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
```

**`src/server/server.ts`** — resolve the dev fallback for `COOKIE_HMAC_KEY` and pass it in. Replace the existing `const app = buildApp({...})` block with:

```ts
const DEV_HMAC_FALLBACK = 'dev-insecure-hmac-key-do-not-use-in-prod-aa'
let cookieHmacKey = env.COOKIE_HMAC_KEY
if (!cookieHmacKey) {
  if (env.NODE_ENV === 'production') {
    throw new Error('COOKIE_HMAC_KEY required in production')
  }
  console.warn('COOKIE_HMAC_KEY not set — using insecure dev default. DO NOT deploy like this.')
  cookieHmacKey = DEV_HMAC_FALLBACK
}

const app = buildApp({
  store,
  redis,
  redisFactory: () => createRedis(env.REDIS_URL),
  pingDb: async () => {
    try { await db.execute(sql`select 1`); return true } catch { return false }
  },
  pingRedis: async () => (await redis.ping()) === 'PONG',
  env: { NODE_ENV: env.NODE_ENV, COOKIE_HMAC_KEY: cookieHmacKey },
})
```

This block will be replaced again in Task 13 to add `mailer` + `PUBLIC_BASE_URL`; for Plan 7 to land incrementally it needs to compile here first.

- [ ] **Step 5: Run tests**

Run: `pnpm test -- tests/unit/server/middleware/cookie.test.ts`
Expected: PASS.

Run: `pnpm test`
Expected: PASS. All existing server/healthz/route tests need their `buildApp(deps)` calls updated to include `COOKIE_HMAC_KEY` in `deps.env`. Fix them as fallout.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors).

- [ ] **Step 7: Commit**

```bash
git add src/server/middleware/cookie.ts src/server/deps.ts src/server/app.ts src/server/server.ts \
        tests/unit/server/middleware/cookie.test.ts \
        $(git ls-files -m tests/unit/server/)
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): HMAC-sign ggcookie with permanent grace path for plain UUIDs"
```

---

## Task 4: Extract bucket.ts from rate-limit.ts

**Files:**
- Create: `src/server/middleware/bucket.ts`
- Modify: `src/server/middleware/rate-limit.ts`
- Test: `tests/unit/server/middleware/bucket.test.ts`

- [ ] **Step 1: Write the failing test for bucket.ts**

Create `tests/unit/server/middleware/bucket.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import { peekBucket, addToBucket } from '../../../../src/server/middleware/bucket.ts'

let redisContainer: StartedTestContainer
let redis: Redis

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redis = new Redis({ host: redisContainer.getHost(), port: redisContainer.getMappedPort(6379) })
}, 30_000)

afterAll(async () => {
  await redis.quit()
  await redisContainer.stop()
})

beforeEach(async () => {
  await redis.flushall()
})

describe('bucket', () => {
  const cfg = { key: 'test:bucket:a', limit: 3, windowMs: 10_000 }

  it('peek returns allowed=true on empty bucket', async () => {
    const r = await peekBucket(redis, cfg, Date.now())
    expect(r).toEqual({ allowed: true, limit: 3, used: 0, retryAfter: 0 })
  })

  it('add increments; peek reflects usage', async () => {
    const t = Date.now()
    await addToBucket(redis, cfg, t)
    await addToBucket(redis, cfg, t + 1)
    const r = await peekBucket(redis, cfg, t + 2)
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(2)
  })

  it('peek returns allowed=false when at limit', async () => {
    const t = Date.now()
    await addToBucket(redis, cfg, t)
    await addToBucket(redis, cfg, t + 1)
    await addToBucket(redis, cfg, t + 2)
    const r = await peekBucket(redis, cfg, t + 3)
    expect(r.allowed).toBe(false)
    expect(r.used).toBe(3)
    expect(r.retryAfter).toBeGreaterThan(0)
    expect(r.retryAfter).toBeLessThanOrEqual(10)
  })

  it('peek returns allowed=true after window rolls forward', async () => {
    const t0 = Date.now()
    await addToBucket(redis, cfg, t0)
    await addToBucket(redis, cfg, t0 + 1)
    await addToBucket(redis, cfg, t0 + 2)
    const r = await peekBucket(redis, cfg, t0 + 10_001)
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(0)
  })

  it('entries exactly at cutoff remain inside the window', async () => {
    const cfgShort = { key: 'test:bucket:b', limit: 1, windowMs: 100 }
    const t0 = Date.now()
    await addToBucket(redis, cfgShort, t0)
    const r = await peekBucket(redis, cfgShort, t0 + 100) // exactly at boundary
    expect(r.used).toBe(1)
    expect(r.allowed).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:integration -- tests/unit/server/middleware/bucket.test.ts`

Note: uses testcontainers. If the file is placed under `tests/unit/` but needs Docker, Vitest's default unit config won't run it. **Move this test** to `tests/integration/server/bucket.test.ts`:

Actually re-decide: keep all bucket-mechanism tests under the integration config (since they need Redis). Move the test file:
- Create: `tests/integration/server/bucket.test.ts` (with the content above)
- Do not create: `tests/unit/server/middleware/bucket.test.ts`

Run: `pnpm test:integration -- tests/integration/server/bucket.test.ts`
Expected: FAIL — `bucket.ts` does not exist.

- [ ] **Step 3: Implement bucket.ts**

Create `src/server/middleware/bucket.ts`:

```ts
import type Redis from 'ioredis'

export interface BucketConfig {
  key: string
  limit: number
  windowMs: number
}

export interface BucketResult {
  allowed: boolean
  limit: number
  used: number
  retryAfter: number
}

export async function peekBucket(redis: Redis, cfg: BucketConfig, now: number): Promise<BucketResult> {
  const cutoff = now - cfg.windowMs
  // Half-open window: (cutoff, now]. Expire STRICTLY less than cutoff.
  await redis.zremrangebyscore(cfg.key, '-inf', String(cutoff - 1))
  const used = await redis.zcard(cfg.key)
  if (used >= cfg.limit) {
    const range = await redis.zrange(cfg.key, 0, 0, 'WITHSCORES')
    const oldestScore = range.length >= 2 ? Number(range[1]) : now
    const retryAfter = Math.ceil((oldestScore + cfg.windowMs - now) / 1000)
    return { allowed: false, limit: cfg.limit, used, retryAfter }
  }
  return { allowed: true, limit: cfg.limit, used, retryAfter: 0 }
}

export async function addToBucket(redis: Redis, cfg: BucketConfig, now: number): Promise<void> {
  await redis.zadd(cfg.key, now, `${now}-${crypto.randomUUID()}`)
  await redis.expire(cfg.key, Math.ceil(cfg.windowMs / 1000))
}
```

- [ ] **Step 4: Refactor rate-limit.ts to call bucket.ts**

Replace `src/server/middleware/rate-limit.ts` with:

```ts
import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import { peekBucket, addToBucket, type BucketResult } from './bucket.ts'

const WINDOW_MS = 86_400_000
const ANON_LIMIT = 3
const VERIFIED_LIMIT = 13

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
  const row = await store.getCookie(cookie)
  const limit = row?.userId ? VERIFIED_LIMIT : ANON_LIMIT
  const cfg = { key: gradeBucketKey(ip, cookie), limit, windowMs: WINDOW_MS }
  const peek = await peekBucket(redis, cfg, now)
  if (!peek.allowed) return peek
  await addToBucket(redis, cfg, now)
  return { allowed: true, limit, used: peek.used + 1, retryAfter: 0 }
}

type Env = { Variables: { clientIp: string; cookie: string } }

export function rateLimitMiddleware(redis: Redis, store: GradeStore): MiddlewareHandler<Env> {
  return async (c, next) => {
    const result = await checkRateLimit(redis, store, c.var.clientIp, c.var.cookie)
    if (!result.allowed) {
      return c.json({
        paywall: 'email' as const,
        limit: result.limit,
        used: result.used,
        retryAfter: result.retryAfter,
      }, 429)
    }
    await next()
  }
}
```

- [ ] **Step 5: Run existing rate-limit tests**

Run: `pnpm test -- tests/unit/server/middleware/rate-limit.test.ts`
Expected: PASS (behavior unchanged; all existing assertions still hold).

Run: `pnpm test:integration -- tests/integration/rate-limit.test.ts`
Expected: PASS.

Run: `pnpm test:integration -- tests/integration/server/bucket.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/middleware/bucket.ts src/server/middleware/rate-limit.ts tests/integration/server/bucket.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "refactor(server): extract peekBucket/addToBucket from rate-limit middleware"
```

---

## Task 5: Mailer interface + ConsoleMailer + FakeMailer

**Files:**
- Create: `src/mail/types.ts`
- Create: `src/mail/console-mailer.ts`
- Create: `tests/unit/_helpers/fake-mailer.ts`
- Test: `tests/unit/server/mail/console-mailer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/server/mail/console-mailer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { ConsoleMailer } from '../../../../src/mail/console-mailer.ts'

describe('ConsoleMailer', () => {
  it('logs email, expiry, and url to stdout', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mailer = new ConsoleMailer()
    const expiresAt = new Date('2030-01-01T12:00:00.000Z')
    await mailer.sendMagicLink({
      email: 'user@example.com',
      url: 'https://geo.example.com/auth/verify?t=abc123',
      expiresAt,
    })
    const allLogs = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(allLogs).toContain('user@example.com')
    expect(allLogs).toContain('https://geo.example.com/auth/verify?t=abc123')
    expect(allLogs).toContain(expiresAt.toISOString())
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/server/mail/console-mailer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the interface and ConsoleMailer**

Create `src/mail/types.ts`:

```ts
export interface MagicLinkMessage {
  email: string
  url: string
  expiresAt: Date
}

export interface Mailer {
  sendMagicLink(msg: MagicLinkMessage): Promise<void>
}
```

Create `src/mail/console-mailer.ts`:

```ts
import type { Mailer, MagicLinkMessage } from './types.ts'

export class ConsoleMailer implements Mailer {
  async sendMagicLink(msg: MagicLinkMessage): Promise<void> {
    const banner = '='.repeat(70)
    console.log(`\n${banner}`)
    console.log(`[ConsoleMailer] magic link for ${msg.email}`)
    console.log(`  expires: ${msg.expiresAt.toISOString()}`)
    console.log(`  url: ${msg.url}`)
    console.log(`${banner}\n`)
  }
}
```

Create `tests/unit/_helpers/fake-mailer.ts`:

```ts
import type { Mailer, MagicLinkMessage } from '../../../src/mail/types.ts'

export class FakeMailer implements Mailer {
  sent: MagicLinkMessage[] = []

  async sendMagicLink(msg: MagicLinkMessage): Promise<void> {
    this.sent.push(msg)
  }

  reset(): void {
    this.sent = []
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/unit/server/mail/console-mailer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mail/ tests/unit/server/mail/ tests/unit/_helpers/fake-mailer.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(mail): add Mailer interface and ConsoleMailer"
```

---

## Task 6: Store — issueMagicToken

**Files:**
- Modify: `src/store/types.ts` (add method signature)
- Modify: `src/store/postgres.ts` (impl)
- Modify: `tests/unit/_helpers/fake-store.ts` (fake impl)
- Test: `tests/unit/store/fake-store-magic.test.ts`
- Test: `tests/integration/store/magic-token.test.ts`

- [ ] **Step 1: Extend `GradeStore` type**

In `src/store/types.ts`, add to the interface:

```ts
// Auth — magic-link flow (Plan 7)
issueMagicToken(email: string, issuingCookie: string): Promise<{ rawToken: string; expiresAt: Date }>
```

- [ ] **Step 2: Write the fake-store test**

Create `tests/unit/store/fake-store-magic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore.issueMagicToken', () => {
  it('returns a rawToken + expiresAt, persists token row', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const { rawToken, expiresAt } = await store.issueMagicToken('user@example.com', 'cookie-1')
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/) // base64url
    expect(rawToken.length).toBeGreaterThanOrEqual(40)
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000) // > 5h from now
    expect(expiresAt.getTime()).toBeLessThan(Date.now() + 7 * 60 * 60 * 1000) // < 7h from now
  })

  it('invalidates prior unconsumed tokens for the same email', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const first = await store.issueMagicToken('user@example.com', 'cookie-1')
    const second = await store.issueMagicToken('user@example.com', 'cookie-1')
    expect(first.rawToken).not.toBe(second.rawToken)
    // Fake store exposes magicTokensMap for test inspection
    const rows = [...store.magicTokensMap.values()].filter((r) => r.email === 'user@example.com')
    expect(rows.length).toBe(2)
    const olderRow = rows.find((r) => r.tokenHash === store._hashForTest(first.rawToken))
    const newerRow = rows.find((r) => r.tokenHash === store._hashForTest(second.rawToken))
    expect(olderRow!.consumedAt).not.toBeNull()
    expect(newerRow!.consumedAt).toBeNull()
  })

  it('does not invalidate tokens for other emails', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const a = await store.issueMagicToken('a@example.com', 'cookie-1')
    await store.issueMagicToken('b@example.com', 'cookie-1')
    const rowA = [...store.magicTokensMap.values()].find((r) => r.tokenHash === store._hashForTest(a.rawToken))
    expect(rowA!.consumedAt).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- tests/unit/store/fake-store-magic.test.ts`
Expected: FAIL — method and map don't exist.

- [ ] **Step 4: Implement in FakeStore**

In `tests/unit/_helpers/fake-store.ts`:

Add to imports:
```ts
import { createHash, randomBytes } from 'node:crypto'
import type { MagicToken } from '../../../src/store/types.ts'
```

Extend `FakeGradeStore`:
```ts
export interface FakeGradeStore extends GradeStore {
  gradesMap: Map<string, Grade>
  scrapesMap: Map<string, Scrape>
  probes: Probe[]
  cookiesMap: Map<string, Cookie>
  usersMap: Map<string, User>
  clearedFor: string[]
  magicTokensMap: Map<string, MagicToken>
  _hashForTest(raw: string): string
}
```

Inside `makeFakeStore`, before the return block:

```ts
const magicTokensMap = new Map<string, MagicToken>()
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}
```

Add to the return object:
```ts
magicTokensMap,
_hashForTest(raw: string): string { return hashToken(raw) },

async issueMagicToken(email: string, issuingCookie: string): Promise<{ rawToken: string; expiresAt: Date }> {
  // Invalidate priors for this email.
  for (const [id, row] of magicTokensMap.entries()) {
    if (row.email === email && row.consumedAt === null) {
      magicTokensMap.set(id, { ...row, consumedAt: new Date() })
    }
  }
  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000)
  const id = crypto.randomUUID()
  magicTokensMap.set(id, {
    id,
    email,
    tokenHash,
    expiresAt,
    consumedAt: null,
    cookie: issuingCookie,
    createdAt: new Date(),
  })
  return { rawToken, expiresAt }
},
```

- [ ] **Step 5: Run fake-store tests**

Run: `pnpm test -- tests/unit/store/fake-store-magic.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write integration test for PostgresStore**

Create `tests/integration/store/magic-token.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { setupTestDb, type TestDb } from '../setup.ts'
import { PostgresStore } from '../../../src/store/postgres.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => { testDb = await setupTestDb() }, 60_000)
afterAll(async () => { await testDb.cleanup() })

beforeEach(async () => {
  await testDb.db.execute(/* sql */`TRUNCATE magic_tokens, cookies, users CASCADE`)
  store = new PostgresStore(testDb.db)
})

describe('PostgresStore.issueMagicToken', () => {
  it('issues a token and persists a row', async () => {
    await store.upsertCookie('cookie-1')
    const { rawToken, expiresAt } = await store.issueMagicToken('user@example.com', 'cookie-1')
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/)
    const rows = await testDb.db.execute(/* sql */`SELECT * FROM magic_tokens WHERE email = 'user@example.com'`)
    expect(rows.length).toBe(1)
  })

  it('invalidates prior unconsumed tokens for same email', async () => {
    await store.upsertCookie('cookie-1')
    await store.issueMagicToken('user@example.com', 'cookie-1')
    await store.issueMagicToken('user@example.com', 'cookie-1')
    const rows = await testDb.db.execute(
      /* sql */`SELECT consumed_at FROM magic_tokens WHERE email = 'user@example.com' ORDER BY created_at`,
    )
    expect(rows.length).toBe(2)
    expect(rows[0].consumed_at).not.toBeNull() // prior
    expect(rows[1].consumed_at).toBeNull()     // new one
  })
})
```

- [ ] **Step 7: Implement in PostgresStore**

In `src/store/postgres.ts`:

Add imports:
```ts
import { and, isNull } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
```

Add method to the class:
```ts
async issueMagicToken(email: string, issuingCookie: string): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000)
  await this.db.transaction(async (tx) => {
    await tx.update(schema.magicTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(schema.magicTokens.email, email), isNull(schema.magicTokens.consumedAt)))
    await tx.insert(schema.magicTokens).values({
      email,
      tokenHash,
      expiresAt,
      cookie: issuingCookie,
    })
  })
  return { rawToken, expiresAt }
}
```

- [ ] **Step 8: Run integration test**

Run: `pnpm test:integration -- tests/integration/store/magic-token.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts \
        tests/unit/store/fake-store-magic.test.ts tests/integration/store/magic-token.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): add issueMagicToken with prior-invalidation transaction"
```

---

## Task 7: Store — consumeMagicToken

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/postgres.ts`
- Modify: `tests/unit/_helpers/fake-store.ts`
- Test: `tests/unit/store/fake-store-consume.test.ts`
- Test: `tests/integration/store/consume-magic-token.test.ts`

- [ ] **Step 1: Extend type**

In `src/store/types.ts`:

```ts
consumeMagicToken(tokenHash: string, clickingCookie: string): Promise<
  | { ok: true; email: string; userId: string }
  | { ok: false }
>
```

- [ ] **Step 2: Write the fake-store test**

Create `tests/unit/store/fake-store-consume.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore.consumeMagicToken', () => {
  it('happy path: upserts user, binds clicking cookie, marks consumed', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-issuer')
    await store.upsertCookie('cookie-clicker')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-issuer')
    const hash = store._hashForTest(rawToken)
    const result = await store.consumeMagicToken(hash, 'cookie-clicker')
    if (!result.ok) throw new Error('expected ok')
    expect(result.email).toBe('user@example.com')
    expect(result.userId).toMatch(/^[0-9a-f-]+$/)
    // Clicking cookie bound, issuing cookie NOT bound
    const clicking = await store.getCookie('cookie-clicker')
    const issuing = await store.getCookie('cookie-issuer')
    expect(clicking!.userId).toBe(result.userId)
    expect(issuing!.userId).toBeNull()
  })

  it('returns ok:false for unknown hash', async () => {
    const store = makeFakeStore()
    const result = await store.consumeMagicToken('nonexistent-hash', 'cookie')
    expect(result).toEqual({ ok: false })
  })

  it('returns ok:false on second consume of same token', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-1')
    const hash = store._hashForTest(rawToken)
    const first = await store.consumeMagicToken(hash, 'cookie-1')
    expect(first.ok).toBe(true)
    const second = await store.consumeMagicToken(hash, 'cookie-1')
    expect(second).toEqual({ ok: false })
  })

  it('returns ok:false for expired token', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-1')
    const hash = store._hashForTest(rawToken)
    // Force expiration
    for (const [id, row] of store.magicTokensMap.entries()) {
      if (row.tokenHash === hash) {
        store.magicTokensMap.set(id, { ...row, expiresAt: new Date(Date.now() - 1000) })
      }
    }
    const result = await store.consumeMagicToken(hash, 'cookie-1')
    expect(result).toEqual({ ok: false })
  })

  it('idempotent user upsert: second verify for same email reuses user', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-a')
    await store.upsertCookie('cookie-b')
    const first = await store.issueMagicToken('user@example.com', 'cookie-a')
    const firstResult = await store.consumeMagicToken(store._hashForTest(first.rawToken), 'cookie-a')
    const second = await store.issueMagicToken('user@example.com', 'cookie-b')
    const secondResult = await store.consumeMagicToken(store._hashForTest(second.rawToken), 'cookie-b')
    if (!firstResult.ok || !secondResult.ok) throw new Error('expected ok')
    expect(firstResult.userId).toBe(secondResult.userId) // same user
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/store/fake-store-consume.test.ts`
Expected: FAIL — method doesn't exist.

- [ ] **Step 4: Implement in FakeStore**

Add to `tests/unit/_helpers/fake-store.ts` inside `makeFakeStore`:

```ts
async consumeMagicToken(
  tokenHash: string,
  clickingCookie: string,
): Promise<{ ok: true; email: string; userId: string } | { ok: false }> {
  let found: MagicToken | undefined
  let foundId: string | undefined
  for (const [id, row] of magicTokensMap.entries()) {
    if (row.tokenHash === tokenHash) { found = row; foundId = id; break }
  }
  if (!found || !foundId) return { ok: false }
  if (found.consumedAt !== null) return { ok: false }
  if (found.expiresAt.getTime() < Date.now()) return { ok: false }

  // Upsert user.
  let user = [...usersMap.values()].find((u) => u.email === found!.email)
  if (!user) {
    user = { id: crypto.randomUUID(), email: found.email, createdAt: new Date() }
    usersMap.set(user.id, user)
  }

  // Bind clicking cookie.
  const clicker = cookiesMap.get(clickingCookie)
  if (clicker) {
    cookiesMap.set(clickingCookie, { ...clicker, userId: user.id })
  } else {
    cookiesMap.set(clickingCookie, { cookie: clickingCookie, userId: user.id, createdAt: new Date() })
  }

  // Mark consumed.
  magicTokensMap.set(foundId, { ...found, consumedAt: new Date() })

  return { ok: true, email: user.email, userId: user.id }
},
```

- [ ] **Step 5: Run fake-store tests**

Run: `pnpm test -- tests/unit/store/fake-store-consume.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write integration test**

Create `tests/integration/store/consume-magic-token.test.ts` — mirrors the fake-store tests but against PG. Verifies: happy path binds clicking cookie (not issuing), double-consume returns ok:false, expired returns ok:false, second verify for same email reuses user.

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { setupTestDb, type TestDb } from '../setup.ts'
import { PostgresStore } from '../../../src/store/postgres.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => { testDb = await setupTestDb() }, 60_000)
afterAll(async () => { await testDb.cleanup() })

beforeEach(async () => {
  await testDb.db.execute(/* sql */`TRUNCATE magic_tokens, cookies, users CASCADE`)
  store = new PostgresStore(testDb.db)
})

const hashOf = (raw: string): string => createHash('sha256').update(raw).digest('hex')

describe('PostgresStore.consumeMagicToken', () => {
  it('binds the CLICKING cookie, not the issuing one', async () => {
    await store.upsertCookie('cookie-issuer')
    await store.upsertCookie('cookie-clicker')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-issuer')
    const result = await store.consumeMagicToken(hashOf(rawToken), 'cookie-clicker')
    if (!result.ok) throw new Error('expected ok')
    const clicker = await store.getCookie('cookie-clicker')
    const issuer = await store.getCookie('cookie-issuer')
    expect(clicker!.userId).toBe(result.userId)
    expect(issuer!.userId).toBeNull()
  })

  it('rejects a second consume of the same token', async () => {
    await store.upsertCookie('cookie-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-1')
    const hash = hashOf(rawToken)
    const first = await store.consumeMagicToken(hash, 'cookie-1')
    expect(first.ok).toBe(true)
    const second = await store.consumeMagicToken(hash, 'cookie-1')
    expect(second).toEqual({ ok: false })
  })

  it('rejects an expired token', async () => {
    await store.upsertCookie('cookie-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-1')
    // Force-expire in DB.
    await testDb.db.execute(/* sql */`UPDATE magic_tokens SET expires_at = now() - interval '1 minute'`)
    const result = await store.consumeMagicToken(hashOf(rawToken), 'cookie-1')
    expect(result).toEqual({ ok: false })
  })

  it('reuses user for second verify of same email', async () => {
    await store.upsertCookie('cookie-a')
    await store.upsertCookie('cookie-b')
    const first = await store.issueMagicToken('user@example.com', 'cookie-a')
    const firstR = await store.consumeMagicToken(hashOf(first.rawToken), 'cookie-a')
    const second = await store.issueMagicToken('user@example.com', 'cookie-b')
    const secondR = await store.consumeMagicToken(hashOf(second.rawToken), 'cookie-b')
    if (!firstR.ok || !secondR.ok) throw new Error('expected ok')
    expect(firstR.userId).toBe(secondR.userId)
  })
})
```

- [ ] **Step 7: Implement in PostgresStore**

Add to `src/store/postgres.ts`:

```ts
async consumeMagicToken(
  tokenHash: string,
  clickingCookie: string,
): Promise<{ ok: true; email: string; userId: string } | { ok: false }> {
  return this.db.transaction(async (tx) => {
    const [tokenRow] = await tx.select().from(schema.magicTokens)
      .where(eq(schema.magicTokens.tokenHash, tokenHash))
      .limit(1)
    if (!tokenRow) return { ok: false as const }
    if (tokenRow.consumedAt !== null) return { ok: false as const }
    if (tokenRow.expiresAt.getTime() < Date.now()) return { ok: false as const }

    const [user] = await tx.insert(schema.users)
      .values({ email: tokenRow.email })
      .onConflictDoUpdate({ target: schema.users.email, set: { email: tokenRow.email } })
      .returning()
    if (!user) throw new Error('consumeMagicToken: user upsert returned no row')

    await tx.update(schema.cookies)
      .set({ userId: user.id })
      .where(eq(schema.cookies.cookie, clickingCookie))

    await tx.update(schema.magicTokens)
      .set({ consumedAt: new Date() })
      .where(eq(schema.magicTokens.id, tokenRow.id))

    return { ok: true as const, email: user.email, userId: user.id }
  })
}
```

- [ ] **Step 8: Run integration test**

Run: `pnpm test:integration -- tests/integration/store/consume-magic-token.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts \
        tests/unit/store/fake-store-consume.test.ts tests/integration/store/consume-magic-token.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): add consumeMagicToken with user upsert and cookie bind"
```

---

## Task 8: Store — unbindCookie + getCookieWithUser

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/postgres.ts`
- Modify: `tests/unit/_helpers/fake-store.ts`
- Test: `tests/unit/store/fake-store-unbind.test.ts`
- Test: `tests/integration/store/unbind-getcookiewithuser.test.ts`

- [ ] **Step 1: Extend type**

In `src/store/types.ts`:

```ts
unbindCookie(cookie: string): Promise<void>
getCookieWithUser(cookie: string): Promise<{ cookie: string; userId: string | null; email: string | null }>
```

- [ ] **Step 2: Write the fake-store tests**

Create `tests/unit/store/fake-store-unbind.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore.unbindCookie', () => {
  it('nulls user_id but keeps cookie row', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const { rawToken } = await store.issueMagicToken('a@b.com', 'c-1')
    await store.consumeMagicToken(store._hashForTest(rawToken), 'c-1')
    const before = await store.getCookie('c-1')
    expect(before!.userId).not.toBeNull()
    await store.unbindCookie('c-1')
    const after = await store.getCookie('c-1')
    expect(after).not.toBeNull()
    expect(after!.userId).toBeNull()
  })

  it('no-op for unknown cookie', async () => {
    const store = makeFakeStore()
    await expect(store.unbindCookie('does-not-exist')).resolves.toBeUndefined()
  })
})

describe('FakeStore.getCookieWithUser', () => {
  it('returns cookie + userId + email when bound', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'c-1')
    await store.consumeMagicToken(store._hashForTest(rawToken), 'c-1')
    const result = await store.getCookieWithUser('c-1')
    expect(result.cookie).toBe('c-1')
    expect(result.userId).not.toBeNull()
    expect(result.email).toBe('user@example.com')
  })

  it('returns null userId + email when unbound', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const result = await store.getCookieWithUser('c-1')
    expect(result.cookie).toBe('c-1')
    expect(result.userId).toBeNull()
    expect(result.email).toBeNull()
  })

  it('returns all-null for nonexistent cookie', async () => {
    const store = makeFakeStore()
    const result = await store.getCookieWithUser('ghost')
    expect(result).toEqual({ cookie: 'ghost', userId: null, email: null })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/store/fake-store-unbind.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement in FakeStore**

Add to `tests/unit/_helpers/fake-store.ts`:

```ts
async unbindCookie(cookie: string): Promise<void> {
  const row = cookiesMap.get(cookie)
  if (!row) return
  cookiesMap.set(cookie, { ...row, userId: null })
},

async getCookieWithUser(cookie: string): Promise<{ cookie: string; userId: string | null; email: string | null }> {
  const row = cookiesMap.get(cookie)
  if (!row) return { cookie, userId: null, email: null }
  if (!row.userId) return { cookie, userId: null, email: null }
  const user = usersMap.get(row.userId)
  return { cookie, userId: row.userId, email: user?.email ?? null }
},
```

- [ ] **Step 5: Run fake tests**

Run: `pnpm test -- tests/unit/store/fake-store-unbind.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the integration test**

Create `tests/integration/store/unbind-getcookiewithuser.test.ts` with analogous cases against PostgresStore.

- [ ] **Step 7: Implement in PostgresStore**

Add to `src/store/postgres.ts`:

```ts
async unbindCookie(cookie: string): Promise<void> {
  await this.db.update(schema.cookies).set({ userId: null }).where(eq(schema.cookies.cookie, cookie))
}

async getCookieWithUser(cookie: string): Promise<{ cookie: string; userId: string | null; email: string | null }> {
  const [row] = await this.db
    .select({
      cookie: schema.cookies.cookie,
      userId: schema.cookies.userId,
      email: schema.users.email,
    })
    .from(schema.cookies)
    .leftJoin(schema.users, eq(schema.users.id, schema.cookies.userId))
    .where(eq(schema.cookies.cookie, cookie))
    .limit(1)
  if (!row) return { cookie, userId: null, email: null }
  return { cookie: row.cookie, userId: row.userId, email: row.email }
}
```

- [ ] **Step 8: Run integration test**

Run: `pnpm test:integration -- tests/integration/store/unbind-getcookiewithuser.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts \
        tests/unit/store/fake-store-unbind.test.ts tests/integration/store/unbind-getcookiewithuser.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): add unbindCookie and getCookieWithUser"
```

---

## Task 9: Auth rate-limit helpers

**Files:**
- Create: `src/server/middleware/auth-rate-limit.ts`
- Test: `tests/integration/server/auth-rate-limit-bucket.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/server/auth-rate-limit-bucket.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import { peekMagicEmailBucket, peekMagicIpBucket, addMagicEmailBucket, addMagicIpBucket } from '../../../src/server/middleware/auth-rate-limit.ts'

let container: StartedTestContainer
let redis: Redis

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
}, 30_000)

afterAll(async () => { await redis.quit(); await container.stop() })
beforeEach(async () => { await redis.flushall() })

describe('auth-rate-limit', () => {
  it('email bucket: limit 1 per 60s', async () => {
    const t = Date.now()
    const r0 = await peekMagicEmailBucket(redis, 'a@b.com', t)
    expect(r0).toEqual({ allowed: true, limit: 1, used: 0, retryAfter: 0 })
    await addMagicEmailBucket(redis, 'a@b.com', t)
    const r1 = await peekMagicEmailBucket(redis, 'a@b.com', t + 1)
    expect(r1.allowed).toBe(false)
    expect(r1.limit).toBe(1)
  })

  it('ip bucket: limit 5 per 10m', async () => {
    const t = Date.now()
    for (let i = 0; i < 5; i++) await addMagicIpBucket(redis, '1.2.3.4', t + i)
    const r = await peekMagicIpBucket(redis, '1.2.3.4', t + 6)
    expect(r.allowed).toBe(false)
    expect(r.limit).toBe(5)
    expect(r.used).toBe(5)
  })

  it('buckets are isolated per-email and per-ip', async () => {
    const t = Date.now()
    await addMagicEmailBucket(redis, 'a@b.com', t)
    const other = await peekMagicEmailBucket(redis, 'c@d.com', t + 1)
    expect(other.allowed).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration -- tests/integration/server/auth-rate-limit-bucket.test.ts`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement helpers**

Create `src/server/middleware/auth-rate-limit.ts`:

```ts
import type Redis from 'ioredis'
import { peekBucket, addToBucket, type BucketResult, type BucketConfig } from './bucket.ts'

const EMAIL_CFG = (email: string): BucketConfig => ({
  key: `magic:email:${email}`,
  limit: 1,
  windowMs: 60_000,
})

const IP_CFG = (ip: string): BucketConfig => ({
  key: `magic:ip:${ip}`,
  limit: 5,
  windowMs: 600_000,
})

export async function peekMagicEmailBucket(redis: Redis, email: string, now: number = Date.now()): Promise<BucketResult> {
  return peekBucket(redis, EMAIL_CFG(email), now)
}

export async function peekMagicIpBucket(redis: Redis, ip: string, now: number = Date.now()): Promise<BucketResult> {
  return peekBucket(redis, IP_CFG(ip), now)
}

export async function addMagicEmailBucket(redis: Redis, email: string, now: number = Date.now()): Promise<void> {
  return addToBucket(redis, EMAIL_CFG(email), now)
}

export async function addMagicIpBucket(redis: Redis, ip: string, now: number = Date.now()): Promise<void> {
  return addToBucket(redis, IP_CFG(ip), now)
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test:integration -- tests/integration/server/auth-rate-limit-bucket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/auth-rate-limit.ts tests/integration/server/auth-rate-limit-bucket.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): add magic-link rate-limit buckets (per-email + per-ip)"
```

---

## Task 10: POST /auth/magic route

**Files:**
- Create: `src/server/routes/auth.ts` (first route)
- Test: `tests/unit/server/routes/auth-magic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server/routes/auth-magic.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import Redis from 'ioredis-mock'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'
import { authRouter } from '../../../../src/server/routes/auth.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'
import { signCookie } from '../../../../src/server/middleware/cookie-sign.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'
const PUBLIC_BASE_URL = 'http://localhost:5173'

function buildAuthApp(store = makeFakeStore(), mailer = new FakeMailer()) {
  const redis = new (Redis as unknown as new () => Redis)()
  const app = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/auth', authRouter({ store, redis: redis as unknown as import('ioredis').default, mailer, publicBaseUrl: PUBLIC_BASE_URL }))
  return { app, store, mailer, redis }
}

async function issueCookie(app: Hono): Promise<string> {
  const res = await app.fetch(new Request('http://test/auth/me'))
  const setCookie = res.headers.get('set-cookie') ?? ''
  const raw = setCookie.split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('POST /auth/magic', () => {
  it('issues token, calls mailer, returns 204', async () => {
    const { app, mailer } = buildAuthApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'user@example.com' }),
    }))
    expect(res.status).toBe(204)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].email).toBe('user@example.com')
    expect(mailer.sent[0].url).toMatch(/^http:\/\/localhost:5173\/auth\/verify\?t=[A-Za-z0-9_-]+$/)
  })

  it('rejects malformed email with 400', async () => {
    const { app } = buildAuthApp()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'not-an-email' }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_email')
  })

  it('normalizes email (trim + lowercase)', async () => {
    const { app, mailer } = buildAuthApp()
    const cookie = await issueCookie(app)
    await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: '  USER@Example.COM  ' }),
    }))
    expect(mailer.sent[0].email).toBe('user@example.com')
  })

  it('per-email rate-limit returns 429 with paywall=email_cooldown', async () => {
    const { app } = buildAuthApp()
    const cookie = await issueCookie(app)
    const post = () => app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'a@b.com' }),
    }))
    await post()
    const second = await post()
    expect(second.status).toBe(429)
    const body = await second.json()
    expect(body.paywall).toBe('email_cooldown')
    expect(body.limit).toBe(1)
  })

  it('per-ip rate-limit returns 429 with paywall=ip_cooldown after 5 different emails', async () => {
    const { app } = buildAuthApp()
    const cookie = await issueCookie(app)
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(new Request('http://test/auth/magic', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
        body: JSON.stringify({ email: `u${i}@b.com` }),
      }))
      expect(res.status).toBe(204)
    }
    const sixth = await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'u5@b.com' }),
    }))
    expect(sixth.status).toBe(429)
    const body = await sixth.json()
    expect(body.paywall).toBe('ip_cooldown')
    expect(body.limit).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/server/routes/auth-magic.test.ts`
Expected: FAIL — `authRouter` and `/auth/magic` don't exist.

- [ ] **Step 3: Create `authRouter` with `/auth/magic`**

Create `src/server/routes/auth.ts`:

```ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import type { Mailer } from '../../mail/types.ts'
import {
  peekMagicEmailBucket, peekMagicIpBucket,
  addMagicEmailBucket, addMagicIpBucket,
} from '../middleware/auth-rate-limit.ts'

export interface AuthRouterDeps {
  store: GradeStore
  redis: Redis
  mailer: Mailer
  publicBaseUrl: string
}

type Env = { Variables: { cookie: string; clientIp: string } }

const magicSchema = z.object({ email: z.string().email().trim().toLowerCase() })

export function authRouter(deps: AuthRouterDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post(
    '/magic',
    zValidator('json', magicSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_email' }, 400)
    }),
    async (c) => {
      const { email } = c.req.valid('json')
      const ip = c.var.clientIp

      const emailPeek = await peekMagicEmailBucket(deps.redis, email)
      if (!emailPeek.allowed) {
        return c.json({
          paywall: 'email_cooldown' as const,
          limit: emailPeek.limit,
          used: emailPeek.used,
          retryAfter: emailPeek.retryAfter,
        }, 429)
      }

      const ipPeek = await peekMagicIpBucket(deps.redis, ip)
      if (!ipPeek.allowed) {
        return c.json({
          paywall: 'ip_cooldown' as const,
          limit: ipPeek.limit,
          used: ipPeek.used,
          retryAfter: ipPeek.retryAfter,
        }, 429)
      }

      const { rawToken, expiresAt } = await deps.store.issueMagicToken(email, c.var.cookie)
      const url = `${deps.publicBaseUrl}/auth/verify?t=${rawToken}`
      await deps.mailer.sendMagicLink({ email, url, expiresAt })

      await addMagicEmailBucket(deps.redis, email)
      await addMagicIpBucket(deps.redis, ip)

      return c.body(null, 204)
    },
  )

  return app
}
```

- [ ] **Step 4: Install ioredis-mock for unit tests**

Check if `ioredis-mock` is already a dev dependency. If not:

```bash
pnpm add -D ioredis-mock
```

- [ ] **Step 5: Run test**

Run: `pnpm test -- tests/unit/server/routes/auth-magic.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/auth.ts tests/unit/server/routes/auth-magic.test.ts package.json pnpm-lock.yaml
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): POST /auth/magic with two-bucket rate limiting"
```

---

## Task 11: GET /auth/verify route

**Files:**
- Modify: `src/server/routes/auth.ts`
- Test: `tests/unit/server/routes/auth-verify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server/routes/auth-verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import Redis from 'ioredis-mock'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'
import { authRouter } from '../../../../src/server/routes/auth.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'
const PUBLIC_BASE_URL = 'http://localhost:5173'

function build() {
  const store = makeFakeStore()
  const mailer = new FakeMailer()
  const redis = new (Redis as unknown as new () => Redis)()
  const app = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/auth', authRouter({
    store, redis: redis as unknown as import('ioredis').default,
    mailer, publicBaseUrl: PUBLIC_BASE_URL,
  }))
  return { app, store, mailer }
}

async function issueCookie(app: Hono): Promise<string> {
  const res = await app.fetch(new Request('http://test/auth/me'))
  return res.headers.get('set-cookie')!.split('ggcookie=')[1]!.split(';')[0]
}

async function getTokenFromMailer(app: Hono, mailer: FakeMailer, email: string, cookie: string): Promise<string> {
  await app.fetch(new Request('http://test/auth/magic', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify({ email }),
  }))
  const url = new URL(mailer.sent.at(-1)!.url)
  return url.searchParams.get('t')!
}

describe('GET /auth/verify', () => {
  it('happy path: redirects to /?verified=1 and binds clicking cookie', async () => {
    const { app, store, mailer } = build()
    const cookie = await issueCookie(app)
    const token = await getTokenFromMailer(app, mailer, 'user@example.com', cookie)
    const res = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }), { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?verified=1')
    const row = await store.getCookie(cookie)
    expect(row!.userId).not.toBeNull()
  })

  it('missing t redirects to /?auth_error=expired_or_invalid', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/verify', {
      headers: { cookie: `ggcookie=${cookie}` },
    }), { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  })

  it('unknown token redirects to auth_error', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/verify?t=' + 'a'.repeat(43), {
      headers: { cookie: `ggcookie=${cookie}` },
    }), { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  })

  it('already-consumed token redirects to auth_error', async () => {
    const { app, mailer } = build()
    const cookie = await issueCookie(app)
    const token = await getTokenFromMailer(app, mailer, 'user@example.com', cookie)
    await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    const second = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }), { redirect: 'manual' })
    expect(second.headers.get('location')).toBe('/?auth_error=expired_or_invalid')
  })

  it('only the clicking cookie gets bound', async () => {
    const { app, store, mailer } = build()
    const issuingCookie = await issueCookie(app)
    const token = await getTokenFromMailer(app, mailer, 'user@example.com', issuingCookie)
    // Click from a DIFFERENT cookie
    const clickingCookie = await issueCookie(app)
    await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${clickingCookie}` },
    }))
    const issuing = await store.getCookie(issuingCookie)
    const clicking = await store.getCookie(clickingCookie)
    expect(issuing!.userId).toBeNull()
    expect(clicking!.userId).not.toBeNull()
  })
})
```

Note: the test uses `new Request(...)` with a signed cookie. Since `issueCookie` returns the signed `<uuid>.<hmac>`, `cookieMiddleware` will verify it correctly.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/server/routes/auth-verify.test.ts`
Expected: FAIL — `/auth/verify` doesn't exist.

- [ ] **Step 3: Add `/auth/verify` to `auth.ts`**

Add imports at top of `src/server/routes/auth.ts`:
```ts
import { createHash } from 'node:crypto'
```

Before the `return app` line, add:

```ts
app.get('/verify', async (c) => {
  const t = c.req.query('t')
  if (!t || !/^[A-Za-z0-9_-]+$/.test(t)) return c.redirect('/?auth_error=expired_or_invalid', 302)
  const tokenHash = createHash('sha256').update(t).digest('hex')
  const result = await deps.store.consumeMagicToken(tokenHash, c.var.cookie)
  if (!result.ok) return c.redirect('/?auth_error=expired_or_invalid', 302)
  return c.redirect('/?verified=1', 302)
})
```

- [ ] **Step 4: Run test**

Run: `pnpm test -- tests/unit/server/routes/auth-verify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/auth.ts tests/unit/server/routes/auth-verify.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): GET /auth/verify with clicking-cookie binding"
```

---

## Task 12: POST /auth/logout + GET /auth/me

**Files:**
- Modify: `src/server/routes/auth.ts`
- Test: `tests/unit/server/routes/auth-logout-me.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server/routes/auth-logout-me.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import Redis from 'ioredis-mock'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'
import { authRouter } from '../../../../src/server/routes/auth.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

function build() {
  const store = makeFakeStore()
  const mailer = new FakeMailer()
  const redis = new (Redis as unknown as new () => Redis)()
  const app = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp(), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/auth', authRouter({
    store, redis: redis as unknown as import('ioredis').default,
    mailer, publicBaseUrl: 'http://localhost:5173',
  }))
  return { app, store, mailer }
}

async function issueCookie(app: Hono): Promise<string> {
  const res = await app.fetch(new Request('http://test/auth/me'))
  return res.headers.get('set-cookie')!.split('ggcookie=')[1]!.split(';')[0]
}

async function verifyForUser(app: Hono, mailer: FakeMailer, cookie: string, email: string): Promise<void> {
  await app.fetch(new Request('http://test/auth/magic', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
    body: JSON.stringify({ email }),
  }))
  const token = new URL(mailer.sent.at(-1)!.url).searchParams.get('t')!
  await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
    headers: { cookie: `ggcookie=${cookie}` },
  }))
}

describe('GET /auth/me', () => {
  it('returns verified:false for a fresh cookie', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/me', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ verified: false })
  })

  it('returns verified:true + email after verify', async () => {
    const { app, mailer } = build()
    const cookie = await issueCookie(app)
    await verifyForUser(app, mailer, cookie, 'user@example.com')
    const res = await app.fetch(new Request('http://test/auth/me', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(await res.json()).toEqual({ verified: true, email: 'user@example.com' })
  })
})

describe('POST /auth/logout', () => {
  it('clears user_id on the cookie; /auth/me returns verified:false', async () => {
    const { app, mailer } = build()
    const cookie = await issueCookie(app)
    await verifyForUser(app, mailer, cookie, 'user@example.com')
    const logoutRes = await app.fetch(new Request('http://test/auth/logout', {
      method: 'POST',
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(logoutRes.status).toBe(204)
    const meRes = await app.fetch(new Request('http://test/auth/me', {
      headers: { cookie: `ggcookie=${cookie}` },
    }))
    expect(await meRes.json()).toEqual({ verified: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/unit/server/routes/auth-logout-me.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Add both routes to `auth.ts`**

Before the `return app` line, add:

```ts
app.post('/logout', async (c) => {
  await deps.store.unbindCookie(c.var.cookie)
  return c.body(null, 204)
})

app.get('/me', async (c) => {
  const row = await deps.store.getCookieWithUser(c.var.cookie)
  if (row.userId && row.email) return c.json({ verified: true, email: row.email })
  return c.json({ verified: false })
})
```

- [ ] **Step 4: Run test**

Run: `pnpm test -- tests/unit/server/routes/auth-logout-me.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full unit suite**

Run: `pnpm test`
Expected: PASS across all unit tests.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/auth.ts tests/unit/server/routes/auth-logout-me.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): POST /auth/logout and GET /auth/me"
```

---

## Task 13: Mount auth routes + wire mailer into ServerDeps

**Files:**
- Modify: `src/server/deps.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/server.ts`
- Modify: `tests/unit/server/healthz.test.ts` (and any other existing test that builds deps)

- [ ] **Step 1: Add mailer + publicBaseUrl to ServerDeps**

`src/server/deps.ts`:

```ts
import type Redis from 'ioredis'
import type { GradeStore } from '../store/types.ts'
import type { Mailer } from '../mail/types.ts'

export interface ServerDeps {
  store: GradeStore
  redis: Redis
  redisFactory: () => Redis
  mailer: Mailer
  pingDb: () => Promise<boolean>
  pingRedis: () => Promise<boolean>
  env: { NODE_ENV: 'development' | 'test' | 'production'; COOKIE_HMAC_KEY: string; PUBLIC_BASE_URL: string }
}
```

- [ ] **Step 2: Mount the auth router in app.ts**

In `src/server/app.ts`, import the router:
```ts
import { authRouter } from './routes/auth.ts'
```

After the `gradeScope` block, before the `if (deps.env.NODE_ENV === 'production')` block, add:

```ts
const authScope = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
authScope.use('*', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production', deps.env.COOKIE_HMAC_KEY))
authScope.route('/', authRouter({
  store: deps.store,
  redis: deps.redis,
  mailer: deps.mailer,
  publicBaseUrl: deps.env.PUBLIC_BASE_URL,
}))
app.route('/auth', authScope)
```

- [ ] **Step 3: Wire mailer + fallbacks in server.ts**

In `src/server/server.ts`, add:

```ts
import { ConsoleMailer } from '../mail/console-mailer.ts'
```

Replace the existing `const app = buildApp({...})` block:

```ts
const DEV_HMAC_FALLBACK = 'dev-insecure-hmac-key-do-not-use-in-prod-aa'
const DEV_PUBLIC_BASE_URL = 'http://localhost:5173'

let cookieHmacKey = env.COOKIE_HMAC_KEY
if (!cookieHmacKey) {
  if (env.NODE_ENV === 'production') throw new Error('COOKIE_HMAC_KEY required in production')
  console.warn('COOKIE_HMAC_KEY not set — using insecure dev default. DO NOT deploy like this.')
  cookieHmacKey = DEV_HMAC_FALLBACK
}

let publicBaseUrl = env.PUBLIC_BASE_URL
if (!publicBaseUrl) {
  if (env.NODE_ENV === 'production') throw new Error('PUBLIC_BASE_URL required in production')
  console.warn(`PUBLIC_BASE_URL not set — falling back to ${DEV_PUBLIC_BASE_URL}.`)
  publicBaseUrl = DEV_PUBLIC_BASE_URL
}

const mailer = new ConsoleMailer()

const app = buildApp({
  store,
  redis,
  redisFactory: () => createRedis(env.REDIS_URL),
  mailer,
  pingDb: async () => {
    try { await db.execute(sql`select 1`); return true } catch { return false }
  },
  pingRedis: async () => (await redis.ping()) === 'PONG',
  env: { NODE_ENV: env.NODE_ENV, COOKIE_HMAC_KEY: cookieHmacKey, PUBLIC_BASE_URL: publicBaseUrl },
})
```

- [ ] **Step 4: Fix broken existing tests**

Every place that builds `ServerDeps` now needs `mailer` and the extended `env`. Grep for broken tests:

Run: `pnpm typecheck`

Expected errors point to `tests/unit/server/healthz.test.ts` and any other unit tests that construct `ServerDeps`. Two changes per broken test:

1. Add import:
   ```ts
   import { FakeMailer } from '../_helpers/fake-mailer.ts'
   ```

2. In the `deps` / `ServerDeps` object literal, add the `mailer` field and replace the `env` block. A typical `ServerDeps` literal in existing tests looks like:

   ```ts
   const deps: ServerDeps = {
     store,
     redis,
     redisFactory: () => redis,
     pingDb: async () => true,
     pingRedis: async () => true,
     env: { NODE_ENV: 'test' },
   }
   ```

   Change it to:

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

- [ ] **Step 5: Run full unit + integration suites**

Run: `pnpm test`
Run: `pnpm test:integration`
Run: `pnpm typecheck`
Run: `pnpm build`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/deps.ts src/server/app.ts src/server/server.ts \
        $(git ls-files -m tests/)
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): wire auth routes and Mailer into ServerDeps"
```

---

## Task 14: Integration tests (end-to-end)

**Files:**
- Create: `tests/integration/auth-magic-link.test.ts`
- Create: `tests/integration/auth-token-failures.test.ts`
- Create: `tests/integration/auth-rate-limit.test.ts`

- [ ] **Step 1: Write `auth-magic-link.test.ts` (happy path)**

This test proves the end-to-end integration: the anonymous rate-limit actually lifts after verify.

Create `tests/integration/auth-magic-link.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../../src/server/app.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { FakeMailer } from '../unit/_helpers/fake-mailer.ts'
import { setupIntegrationHarness, type IntegrationHarness } from './setup.ts'

let harness: IntegrationHarness
let mailer: FakeMailer

beforeAll(async () => { harness = await setupIntegrationHarness() }, 90_000)
afterAll(async () => { await harness.cleanup() })

beforeEach(async () => {
  await harness.db.execute(/* sql */`TRUNCATE grades, scrapes, probes, recommendations, reports, stripe_payments, magic_tokens, cookies, users RESTART IDENTITY CASCADE`)
  await harness.redis.flushall()
  mailer = new FakeMailer()
})

function buildHarnessApp() {
  return buildApp({
    store: new PostgresStore(harness.db),
    redis: harness.redis,
    redisFactory: () => harness.createRedis(),
    mailer,
    pingDb: async () => true,
    pingRedis: async () => true,
    env: { NODE_ENV: 'test', COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa', PUBLIC_BASE_URL: 'http://localhost:5173' },
  })
}

describe('magic-link — full flow', () => {
  it('rate-limit lifts after verify', async () => {
    const app = buildHarnessApp()
    const bootstrap = await app.fetch(new Request('http://test/auth/me'))
    const cookie = bootstrap.headers.get('set-cookie')!.split('ggcookie=')[1]!.split(';')[0]

    // 3 anonymous grades pass
    for (let i = 0; i < 3; i++) {
      const r = await app.fetch(new Request('http://test/grades', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
        body: JSON.stringify({ url: `https://example.com/p${i}` }),
      }))
      expect(r.status).toBe(202)
    }
    // 4th is 429
    const fourth = await app.fetch(new Request('http://test/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ url: 'https://example.com/p4' }),
    }))
    expect(fourth.status).toBe(429)

    // Request magic link, pluck token, verify
    await app.fetch(new Request('http://test/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ email: 'user@example.com' }),
    }))
    const token = new URL(mailer.sent[0].url).searchParams.get('t')!
    const verifyRes = await app.fetch(new Request(`http://test/auth/verify?t=${token}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    }), { redirect: 'manual' })
    expect(verifyRes.status).toBe(302)
    expect(verifyRes.headers.get('location')).toBe('/?verified=1')

    // 4th grade now passes (limit lifted to 13)
    const retried = await app.fetch(new Request('http://test/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ url: 'https://example.com/p4' }),
    }))
    expect(retried.status).toBe(202)
  }, 60_000)
})
```

- [ ] **Step 2: Run it**

Run: `pnpm test:integration -- tests/integration/auth-magic-link.test.ts`
Expected: PASS.

- [ ] **Step 3: Write `auth-token-failures.test.ts`**

Create with cases: (a) expired token → auth_error redirect; (b) reuse same token twice → second attempt redirects.

- [ ] **Step 4: Write `auth-rate-limit.test.ts`**

Two cases: (a) 2nd POST /auth/magic within 60s for same email → 429 email_cooldown, (b) 6th POST /auth/magic within 10m from same IP with different emails → 429 ip_cooldown.

- [ ] **Step 5: Run all integration tests**

Run: `pnpm test:integration`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/auth-magic-link.test.ts tests/integration/auth-token-failures.test.ts tests/integration/auth-rate-limit.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(auth): integration tests for magic-link flow, failures, rate limits"
```

---

## Task 15: Frontend — api.ts helpers + useAuth hook

**Files:**
- Modify: `src/web/lib/api.ts`
- Create: `src/web/hooks/useAuth.ts`
- Test: `tests/unit/web/hooks/useAuth.test.tsx`

- [ ] **Step 1: Add the three API helpers**

Append to `src/web/lib/api.ts`:

```ts
export type MagicResult =
  | { ok: true }
  | { ok: false; error: 'invalid_email' | 'rate_limit_email' | 'rate_limit_ip'; retryAfter?: number }

export async function postAuthMagic(email: string): Promise<MagicResult> {
  const res = await fetch('/auth/magic', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (res.status === 204) return { ok: true }
  if (res.status === 400) return { ok: false, error: 'invalid_email' }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}))
    const error = body.paywall === 'email_cooldown' ? 'rate_limit_email' : 'rate_limit_ip'
    return { ok: false, error, retryAfter: body.retryAfter }
  }
  return { ok: false, error: 'rate_limit_ip' } // fallback
}

export async function postAuthLogout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
}

export async function getAuthMe(): Promise<{ verified: boolean; email?: string }> {
  const res = await fetch('/auth/me', { credentials: 'include' })
  if (!res.ok) return { verified: false }
  return res.json()
}
```

- [ ] **Step 2: Write the failing hook test**

Create `tests/unit/web/hooks/useAuth.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useAuth } from '../../../../src/web/hooks/useAuth.ts'

beforeEach(() => { vi.restoreAllMocks() })

describe('useAuth', () => {
  it('starts unverified; refresh() pulls from /auth/me', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true, email: 'u@ex.com' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.verified).toBe(true))
    expect(result.current.email).toBe('u@ex.com')
  })

  it('logout() posts to /auth/logout and refreshes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true, email: 'u@ex.com' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.verified).toBe(true))
    await act(async () => { await result.current.logout() })
    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(result.current.verified).toBe(false))
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- tests/unit/web/hooks/useAuth.test.tsx`
Expected: FAIL — hook doesn't exist.

- [ ] **Step 4: Implement useAuth**

Create `src/web/hooks/useAuth.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'
import { getAuthMe, postAuthLogout } from '../lib/api.ts'

export interface AuthState {
  verified: boolean
  email: string | null
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

export function useAuth(): AuthState {
  const [verified, setVerified] = useState<boolean>(false)
  const [email, setEmail] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const me = await getAuthMe()
    setVerified(me.verified)
    setEmail(me.email ?? null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    await postAuthLogout()
    await refresh()
  }, [refresh])

  return { verified, email, refresh, logout }
}
```

- [ ] **Step 5: Run test**

Run: `pnpm test -- tests/unit/web/hooks/useAuth.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/api.ts src/web/hooks/useAuth.ts tests/unit/web/hooks/useAuth.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): add postAuthMagic/postAuthLogout/getAuthMe + useAuth hook"
```

---

## Task 16: Frontend — Toast component + LandingPage toast/banner

**Files:**
- Create: `src/web/components/Toast.tsx`
- Test: `tests/unit/web/components/Toast.test.tsx`
- Modify: `src/web/pages/LandingPage.tsx`
- Modify: `tests/unit/web/pages/LandingPage.test.tsx`

- [ ] **Step 1: Write the failing Toast test**

Create `tests/unit/web/components/Toast.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { Toast } from '../../../../src/web/components/Toast.tsx'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('Toast', () => {
  it('renders the message', () => {
    render(<Toast message="hi" onDismiss={() => {}} />)
    expect(screen.getByText('hi')).toBeInTheDocument()
  })

  it('auto-dismisses after durationMs (default 5000)', () => {
    const onDismiss = vi.fn()
    render(<Toast message="hi" onDismiss={onDismiss} />)
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('respects custom durationMs', () => {
    const onDismiss = vi.fn()
    render(<Toast message="hi" durationMs={2000} onDismiss={onDismiss} />)
    act(() => { vi.advanceTimersByTime(1999) })
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm test -- tests/unit/web/components/Toast.test.tsx`

- [ ] **Step 3: Implement Toast**

Create `src/web/components/Toast.tsx`:

```tsx
import { useEffect } from 'react'

interface ToastProps {
  message: string
  durationMs?: number
  onDismiss: () => void
}

export function Toast({ message, durationMs = 5000, onDismiss }: ToastProps): JSX.Element {
  useEffect(() => {
    const handle = setTimeout(onDismiss, durationMs)
    return () => clearTimeout(handle)
  }, [message, durationMs, onDismiss])

  return (
    <div
      role="status"
      className="fixed bottom-6 right-6 bg-[var(--color-bg-elevated)] border border-[var(--color-good)] text-[var(--color-fg)] px-4 py-3 text-sm"
    >
      {message}
    </div>
  )
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Write LandingPage test cases**

Append to `tests/unit/web/pages/LandingPage.test.tsx`:

```tsx
describe('LandingPage — auth feedback', () => {
  it('renders toast when ?verified=1 is present; strips param after render', async () => {
    vi.useFakeTimers()
    // Render with ?verified=1
    window.history.pushState({}, '', '/?verified=1')
    render(<MemoryRouter initialEntries={['/?verified=1']}><LandingPage /></MemoryRouter>)
    expect(screen.getByRole('status')).toHaveTextContent(/you're in/i)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.queryByRole('status')).toBeNull()
    vi.useRealTimers()
  })

  it('renders auth_error banner when ?auth_error is present', () => {
    render(<MemoryRouter initialEntries={['/?auth_error=expired_or_invalid']}><LandingPage /></MemoryRouter>)
    expect(screen.getByText(/sign-in link didn't work/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute('href', '/email')
  })
})
```

- [ ] **Step 6: Run — expect FAIL**

- [ ] **Step 7: Update LandingPage**

In `src/web/pages/LandingPage.tsx`, add (near the top, inside the component):

```tsx
import { Toast } from '../components/Toast.tsx'
// ...

const [params, setParams] = useSearchParams()
const [verifiedToast, setVerifiedToast] = useState<boolean>(params.get('verified') === '1')
const [authError, setAuthError] = useState<string | null>(params.get('auth_error'))

useEffect(() => {
  if (params.get('verified') === '1') {
    const next = new URLSearchParams(params)
    next.delete('verified')
    setParams(next, { replace: true })
  }
  if (params.get('auth_error')) {
    const next = new URLSearchParams(params)
    next.delete('auth_error')
    setParams(next, { replace: true })
  }
}, [])
```

Add to JSX (before the main form area):

```tsx
{authError && (
  <div className="bg-[var(--color-bg-elevated)] border border-[var(--color-brand)] text-[var(--color-fg)] px-4 py-3 mb-6 flex items-center justify-between">
    <span>Your sign-in link didn't work or expired.</span>
    <a href="/email" className="text-[var(--color-brand)] underline">Request a new link →</a>
  </div>
)}
{verifiedToast && (
  <Toast
    message="You're in — 10 more grades in this 24h window."
    onDismiss={() => setVerifiedToast(false)}
  />
)}
```

- [ ] **Step 8: Run — expect PASS**

Run: `pnpm test -- tests/unit/web/`
Expected: all frontend tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/web/components/Toast.tsx src/web/pages/LandingPage.tsx \
        tests/unit/web/components/Toast.test.tsx tests/unit/web/pages/LandingPage.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): Toast + LandingPage verified toast and auth-error banner"
```

---

## Task 17: Frontend — EmailGatePage resend + Header sign-out

**Files:**
- Modify: `src/web/pages/EmailGatePage.tsx`
- Modify: `tests/unit/web/pages/EmailGatePage.test.tsx`
- Modify: `src/web/components/Header.tsx`
- Modify: `tests/unit/web/components/Header.test.tsx`
- Modify: `src/web/App.tsx` (wrap in AuthContext)

- [ ] **Step 1: Write EmailGatePage resend-cooldown tests**

Append to `tests/unit/web/pages/EmailGatePage.test.tsx`:

```tsx
describe('EmailGatePage resend flow', () => {
  it('shows resend button after success; disabled with countdown until 60s pass', async () => {
    vi.useFakeTimers()
    const postMock = vi.fn().mockResolvedValue({ ok: true })
    vi.doMock('../../../../src/web/lib/api.ts', () => ({ postAuthMagic: postMock }))
    // Submit form
    render(<MemoryRouter><EmailGatePage /></MemoryRouter>)
    await user.type(screen.getByPlaceholderText(/you@example.com/i), 'me@example.com')
    await user.click(screen.getByRole('button', { name: /send link/i }))
    const resend = await screen.findByRole('button', { name: /resend in \d+s/i })
    expect(resend).toBeDisabled()
    act(() => { vi.advanceTimersByTime(60_000) })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /resend/i })).not.toBeDisabled()
    })
    vi.useRealTimers()
  })

  it('shows rate_limit_email error with retryAfter', async () => {
    const postMock = vi.fn().mockResolvedValue({ ok: false, error: 'rate_limit_email', retryAfter: 42 })
    vi.doMock('../../../../src/web/lib/api.ts', () => ({ postAuthMagic: postMock }))
    render(<MemoryRouter><EmailGatePage /></MemoryRouter>)
    await user.type(screen.getByPlaceholderText(/you@example.com/i), 'me@example.com')
    await user.click(screen.getByRole('button', { name: /send link/i }))
    expect(await screen.findByText(/wait 42s/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Rewrite EmailGatePage with resend state**

Replace entire `src/web/pages/EmailGatePage.tsx` contents:

```tsx
import React, { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { postAuthMagic } from '../lib/api.ts'

function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const leftoverMinutes = minutes % 60
  return `${hours}h ${leftoverMinutes}m`
}

export function EmailGatePage(): JSX.Element {
  const [params] = useSearchParams()
  const retrySeconds = Number(params.get('retry') ?? '0')
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldownUntil, setCooldownUntil] = useState<number>(0)
  const [now, setNow] = useState<number>(Date.now())

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [])

  const cooldownSecs = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  async function submit(): Promise<void> {
    if (email.trim().length === 0) return
    setPending(true); setError(null)
    const result = await postAuthMagic(email.trim())
    setPending(false)
    if (result.ok) {
      setSent(true)
      setCooldownUntil(Date.now() + 60_000)
      return
    }
    if (result.error === 'invalid_email') { setError("That doesn't look like a valid email."); return }
    if (result.error === 'rate_limit_email') {
      setError(`Please wait ${result.retryAfter ?? 60}s before resending.`)
      if (result.retryAfter) setCooldownUntil(Date.now() + result.retryAfter * 1000)
      return
    }
    setError(`Too many requests from this connection. Try again in ${Math.ceil((result.retryAfter ?? 600) / 60)}m.`)
    if (result.retryAfter) setCooldownUntil(Date.now() + result.retryAfter * 1000)
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    await submit()
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">paywall</div>
      <h1 className="text-2xl mt-2 mb-2 text-[var(--color-fg)]">You've hit your free limit</h1>
      <p className="text-[var(--color-fg-dim)] mb-4">
        3 grades per 24 hours for anonymous visitors. Verify your email and we'll unlock{' '}
        <span className="text-[var(--color-good)]">10 more</span>.
      </p>
      {retrySeconds > 0 && (
        <div className="text-xs text-[var(--color-fg-muted)] mb-4">
          Or come back in <span className="text-[var(--color-fg-dim)]">{formatRetry(retrySeconds)}</span>.
        </div>
      )}

      {!sent ? (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-brand)]"
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending}
            className="bg-[var(--color-brand)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
          >
            {pending ? '...' : 'send link'}
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="text-sm text-[var(--color-good)]">Check your email for a sign-in link.</div>
          <button
            type="button"
            onClick={submit}
            disabled={cooldownSecs > 0 || pending}
            className="bg-[var(--color-bg-elevated)] border border-[var(--color-line)] text-[var(--color-fg)] px-4 py-2 text-sm disabled:opacity-50"
          >
            {cooldownSecs > 0 ? `Resend in ${cooldownSecs}s` : 'Resend link'}
          </button>
        </div>
      )}

      {error !== null && (
        <div className="text-xs text-[var(--color-brand)] mt-3">{error}</div>
      )}

      <div className="mt-12">
        <Link to="/" className="text-[var(--color-brand)] text-xs">← back to home</Link>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Write Header sign-out test**

Append to `tests/unit/web/components/Header.test.tsx`:

```tsx
describe('Header — sign-out', () => {
  it('shows sign-out link when verified', () => {
    vi.doMock('../../../../src/web/hooks/useAuth.ts', () => ({
      useAuth: () => ({ verified: true, email: 'u@e.com', refresh: async () => {}, logout: async () => {} }),
    }))
    render(<MemoryRouter><Header /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })

  it('hides sign-out link when not verified', () => {
    vi.doMock('../../../../src/web/hooks/useAuth.ts', () => ({
      useAuth: () => ({ verified: false, email: null, refresh: async () => {}, logout: async () => {} }),
    }))
    render(<MemoryRouter><Header /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull()
  })

  it('calls logout when sign-out clicked', async () => {
    const logoutMock = vi.fn().mockResolvedValue(undefined)
    vi.doMock('../../../../src/web/hooks/useAuth.ts', () => ({
      useAuth: () => ({ verified: true, email: 'u@e.com', refresh: async () => {}, logout: logoutMock }),
    }))
    render(<MemoryRouter><Header /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: /sign out/i }))
    expect(logoutMock).toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: Add sign-out link to Header**

In `src/web/components/Header.tsx`, import the hook:
```tsx
import { useAuth } from '../hooks/useAuth.ts'
```

In the JSX, on the right side of the header bar:
```tsx
const { verified, logout } = useAuth()
// ...
{verified && (
  <button
    type="button"
    onClick={() => void logout()}
    className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
  >
    sign out
  </button>
)}
```

- [ ] **Step 7: Run — expect PASS**

Run: `pnpm test -- tests/unit/web/`
Expected: all frontend tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/web/pages/EmailGatePage.tsx src/web/components/Header.tsx \
        tests/unit/web/pages/EmailGatePage.test.tsx tests/unit/web/components/Header.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): EmailGatePage resend cooldown + Header sign-out link"
```

---

## Task 18: Documentation updates

**Files:**
- Modify: `docs/production-checklist.md`
- Modify: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` (master-spec anchor)
- Modify: `README.md` (brief auth mention)

- [ ] **Step 1: Update production checklist**

In `docs/production-checklist.md`:

**Remove** the "Cookie signing (HMAC) for anonymous tracker" bullet from the Security section (Plan 7 ships it).

**Add** to Security:
```markdown
- [ ] **Atomic rate-limit for /auth/magic.** Plan 7 added per-email (1/60s) and per-IP (5/10m) buckets using the same peek-then-add pattern as the grade rate-limit. Two concurrent POST /auth/magic calls from the same (email, IP) pair could both peek-allowed and both add. Impact is bounded (one extra email per race window). Fix with the same Lua-script approach we owe the grade bucket.
- [ ] **CSRF tokens on mutation routes.** Plan 7 ships POST /auth/logout without a CSRF token, relying on SameSite=Lax. Fine for logout specifically (worst case: a CSRF attack forces a sign-out — nuisance, not compromise). When Plan 8/9+ add delete-grade, delete-account, or profile-edit mutations, introduce a proper CSRF token mechanism (double-submit cookie or per-session token).
```

**Add** to Deploy / ops:
```markdown
- [ ] **Real email provider + DKIM/SPF/DMARC.** Plan 7 ships ConsoleMailer only — magic-link URLs get logged to stdout. Pick Resend or Postmark, set up the DNS records, and wire `RealMailer` in place of `ConsoleMailer` via `env.RESEND_API_KEY` (or equivalent). Interface is already in place at `src/mail/types.ts`; the swap is one line in `src/server/server.ts`.
```

**Add** to UX / product:
```markdown
- [ ] **Magic-link preserve-intent redirect.** Plan 7 redirects post-verify to `/?verified=1`; the user has to re-type whatever URL they were trying to grade. Preserve-intent would thread the original URL through the magic-link query string and auto-pre-fill the landing-page input. Deferred because it adds plumbing across four touch points (paywall URL capture, magic-link URL, verify redirect, landing auto-fill) and benefits from observing real user drop-off first.
```

- [ ] **Step 2: Update master-spec anchor**

In `docs/superpowers/specs/2026-04-17-geo-reporter-design.md`, find §7.2 and add a sub-paragraph:

```markdown
> **Sub-spec:** See `docs/superpowers/specs/2026-04-19-geo-reporter-plan-7-auth-design.md` for the Plan 7 design — brainstormed 2026-04-19, shipped in Plan 7.
```

- [ ] **Step 3: Update README**

In `README.md`, find the Roadmap section. Change Plan 7 line from "Plan 7 — Auth (magic link): PENDING" to "Plan 7 — Auth (magic link): Done (YYYY-MM-DD)" with today's merge date.

Briefly add to the "Grading in the browser" section (or wherever the email-gate flow is mentioned): a sentence noting that verifying your email lifts the quota from 3 to 13 per 24h, and that in dev the magic link is printed to the worker/server stdout via `ConsoleMailer`.

- [ ] **Step 4: Run full validation**

Run: `pnpm test`
Run: `pnpm test:integration`
Run: `pnpm typecheck`
Run: `pnpm build`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/production-checklist.md docs/superpowers/specs/2026-04-17-geo-reporter-design.md README.md
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "docs: Plan 7 wrap-up — checklist diff, master-spec anchor, README update"
```

---

## Final verification

After all tasks complete:

- [ ] Run `pnpm test` → all unit tests pass.
- [ ] Run `pnpm test:integration` → all integration tests pass.
- [ ] Run `pnpm typecheck` → no errors.
- [ ] Run `pnpm build` → server.js and worker.js bundle clean.
- [ ] Manually smoke-test the full flow locally:
  1. `pnpm dev:server`, `pnpm dev:worker`, `pnpm dev:web`.
  2. Open `http://localhost:5173`.
  3. Submit 3 grades anonymously; confirm 4th is paywalled to `/email`.
  4. Type your email, click "send link".
  5. Check the **server terminal** (where ConsoleMailer logged) for the magic URL; paste into browser.
  6. Expect redirect to `/?verified=1` with a 5s toast.
  7. Submit a 4th grade successfully (limit now 13).
  8. Click "sign out" in header; confirm the link disappears.
  9. Test error paths: click an expired/reused magic link; expect `/?auth_error=expired_or_invalid` banner.
