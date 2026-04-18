# GEO Reporter Plan 6a — HTTP Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Hono HTTP surface the browser (Plan 6b) will talk to: `POST /grades`, `GET /grades/:id`, `GET /grades/:id/events` (SSE) — plus the middleware stack they share (client IP, anonymous cookie, rate limit) and a dep-injection seam for testing.

**Architecture:** Three route files + three middleware files + a `ServerDeps` injection interface. `app.fetch(Request)` drives unit tests against in-memory fakes; real testcontainers Redis + Postgres drive integration tests for the rate-limit lifecycle and the SSE live-events flow. SSE hydrates past state from Postgres on every connect, then forwards Redis pub/sub events from Plan 5.

**Tech Stack:** TypeScript 5.6+ strict, Hono 4, `@hono/zod-validator` (new runtime dep), vitest 2 + testcontainers 10. No new dev dependencies.

---

## Spec references

- Sub-spec (source of truth): `docs/superpowers/specs/2026-04-18-geo-reporter-plan-6a-http-surface-design.md`
- Master spec: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` §4.3 (trace steps 1–4) + §10 (API surface). Master spec anchor landed at commit `7998303`.

**Interpretation calls locked in (sub-spec §2, brainstormed 2026-04-18):**

- P6a-0: Plan split — this plan is 6a only; Plan 6b covers the React frontend.
- P6a-1: Cookie = plain UUID v4, httpOnly/sameSite=Lax/secure-in-prod, 1yr.
- P6a-2: Client IP = `X-Forwarded-For` first value, else socket, else `0.0.0.0`.
- P6a-3: Rate-limit anon=3/24h, email-verified=13/24h; lookup via `cookies.userId`.
- P6a-4: 429 body = `{ paywall: 'email', limit, used, retryAfter }`.
- P6a-5: SSE always hydrates past state on connect.
- P6a-6: SSE auth = cookie must match `grades.cookie` (403 otherwise).
- P6a-7: URL validation = Zod + `http:`/`https:` scheme check only.
- P6a-8: Concurrent grades per cookie allowed; rate limit is the cap.
- P6a-9: `@hono/zod-validator` for request bodies.
- P6a-10: CORS = allow `http://localhost:5173` with credentials in development only.
- P6a-11: Tests = `app.request()` for units, real HTTP for SSE integration.

---

## File structure

```
src/server/
├── server.ts                     MODIFY — build ServerDeps, pass to buildApp
├── app.ts                        MODIFY — compose middleware stack + mount routes
├── deps.ts                       NEW — ServerDeps interface
├── middleware/
│   ├── client-ip.ts              NEW
│   ├── cookie.ts                 NEW
│   └── rate-limit.ts             NEW
└── routes/
    ├── grades.ts                 NEW
    └── grades-events.ts          NEW

src/store/
├── types.ts                      MODIFY — add getCookie to GradeStore interface
└── postgres.ts                   MODIFY — implement getCookie

package.json                      MODIFY — add @hono/zod-validator runtime dep

tests/unit/
├── _helpers/
│   └── fake-store.ts             NEW — extracted makeFakeStore (from Plan 5's inline copies)
└── server/
    ├── healthz.test.ts           MODIFY — update deps shape for new ServerDeps
    ├── middleware/
    │   ├── client-ip.test.ts     NEW
    │   ├── cookie.test.ts        NEW
    │   └── rate-limit.test.ts    NEW
    └── routes/
        ├── grades.test.ts        NEW
        └── grades-events.test.ts NEW

tests/integration/server/
├── rate-limit.test.ts            NEW — real Redis + Postgres bucket lifecycle
└── grades-events-live.test.ts    NEW — real HTTP + in-process worker, full SSE
```

---

## Project constraints (from CLAUDE.md)

- `.ts` extensions on ALL imports.
- `import type` for type-only imports.
- `exactOptionalPropertyTypes: true` — conditionally assign optional fields.
- `noUncheckedIndexedAccess: true` — `arr[0]` is `T | undefined`.
- Inline git identity: `git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit …`. Never touch global config.
- `pnpm` only.
- Unit tests in `tests/unit/**`; integration tests in `tests/integration/**`.

---

## Task 1 — Dependency + `GradeStore.getCookie` + shared fake-store helper

**Files:**
- Modify: `package.json` (add `@hono/zod-validator`)
- Modify: `src/store/types.ts` (add `getCookie` to `GradeStore`)
- Modify: `src/store/postgres.ts` (implement `getCookie`)
- Create: `tests/unit/_helpers/fake-store.ts` (extract from Plan 5's inline copies)
- Create: `tests/integration/store-get-cookie.test.ts` (integration test for `getCookie`)

### Step 1: Add `@hono/zod-validator` runtime dep

Run: `pnpm add @hono/zod-validator@^0.2.2`
Expected: added to `dependencies` in `package.json`.

### Step 2: Add `getCookie` to the `GradeStore` interface

Modify `src/store/types.ts`. In the `GradeStore` interface, after `upsertCookie`, add:
```ts
  getCookie(cookie: string): Promise<Cookie | null>
```

### Step 3: Write failing integration test

Create `tests/integration/store-get-cookie.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => {
  testDb = await startTestDb()
  store = new PostgresStore(testDb.db)
}, 60_000)

afterAll(async () => {
  await testDb.stop()
})

describe('PostgresStore.getCookie', () => {
  it('returns null for a cookie that does not exist', async () => {
    expect(await store.getCookie('does-not-exist')).toBeNull()
  })

  it('returns the row after upsertCookie', async () => {
    await store.upsertCookie('cookie-gc-1')
    const row = await store.getCookie('cookie-gc-1')
    expect(row).not.toBeNull()
    expect(row?.cookie).toBe('cookie-gc-1')
    expect(row?.userId).toBeNull()
  })

  it('reflects userId after binding', async () => {
    const user = await store.upsertUser('gc-user@example.com')
    await store.upsertCookie('cookie-gc-2', user.id)
    const row = await store.getCookie('cookie-gc-2')
    expect(row?.userId).toBe(user.id)
  })
})
```

### Step 4: Run it; expect FAIL

Run: `pnpm test:integration tests/integration/store-get-cookie.test.ts`
Expected: FAIL — `store.getCookie is not a function`.

### Step 5: Implement `getCookie` on `PostgresStore`

Modify `src/store/postgres.ts`. Add the method anywhere in the class (e.g. after `upsertCookie`):
```ts
  async getCookie(cookie: string): Promise<Cookie | null> {
    const [row] = await this.db.select().from(schema.cookies).where(eq(schema.cookies.cookie, cookie)).limit(1)
    return row ?? null
  }
```

### Step 6: Run integration test; expect 3 PASS

Run: `pnpm test:integration tests/integration/store-get-cookie.test.ts`
Expected: PASS (3 tests).

### Step 7: Create shared fake-store helper

Plan 5's unit tests (`categories.test.ts`, `run-grade.test.ts`) each define `makeFakeStore` inline — the Plan 5 review flagged this duplication. Plan 6a reuses the fake and needs `getCookie`. Extract to a shared helper now.

Create `tests/unit/_helpers/fake-store.ts`:
```ts
import type {
  GradeStore, Grade, Probe, Scrape, NewGrade, NewProbe, NewScrape, GradeUpdate,
  User, Cookie, Recommendation, NewRecommendation, Report, NewReport,
} from '../../../src/store/types.ts'

export interface FakeGradeStore extends GradeStore {
  gradesMap: Map<string, Grade>
  scrapesMap: Map<string, Scrape>
  probes: Probe[]
  cookiesMap: Map<string, Cookie>
  usersMap: Map<string, User>
  clearedFor: string[]
}

export function makeFakeStore(): FakeGradeStore {
  const gradesMap = new Map<string, Grade>()
  const scrapesMap = new Map<string, Scrape>()
  const probes: Probe[] = []
  const cookiesMap = new Map<string, Cookie>()
  const usersMap = new Map<string, User>()
  const clearedFor: string[] = []

  return {
    gradesMap, scrapesMap, probes, cookiesMap, usersMap, clearedFor,

    async createGrade(input: NewGrade): Promise<Grade> {
      const id = input.id ?? crypto.randomUUID()
      const now = new Date()
      const g: Grade = {
        id, url: input.url, domain: input.domain, tier: input.tier,
        cookie: input.cookie ?? null, userId: input.userId ?? null,
        status: input.status ?? 'queued',
        overall: input.overall ?? null, letter: input.letter ?? null, scores: input.scores ?? null,
        createdAt: now, updatedAt: now,
      }
      gradesMap.set(id, g)
      return g
    },
    async getGrade(id: string): Promise<Grade | null> { return gradesMap.get(id) ?? null },
    async updateGrade(id: string, patch: GradeUpdate): Promise<void> {
      const g = gradesMap.get(id)
      if (!g) return
      gradesMap.set(id, { ...g, ...patch, updatedAt: new Date() })
    },
    async createProbe(input: NewProbe): Promise<Probe> {
      const p: Probe = {
        id: crypto.randomUUID(), gradeId: input.gradeId, category: input.category,
        provider: input.provider ?? null, prompt: input.prompt, response: input.response,
        score: input.score ?? null, metadata: input.metadata ?? {}, createdAt: new Date(),
      }
      probes.push(p)
      return p
    },
    async listProbes(gradeId: string): Promise<Probe[]> {
      return probes.filter((p) => p.gradeId === gradeId)
    },
    async createScrape(input: NewScrape): Promise<Scrape> {
      const s: Scrape = {
        id: crypto.randomUUID(), gradeId: input.gradeId, rendered: input.rendered ?? false,
        html: input.html, text: input.text, structured: input.structured,
        fetchedAt: input.fetchedAt ?? new Date(),
      }
      scrapesMap.set(input.gradeId, s)
      return s
    },
    async getScrape(gradeId: string): Promise<Scrape | null> { return scrapesMap.get(gradeId) ?? null },
    async clearGradeArtifacts(gradeId: string): Promise<void> {
      clearedFor.push(gradeId)
      scrapesMap.delete(gradeId)
      for (let i = probes.length - 1; i >= 0; i--) if (probes[i]?.gradeId === gradeId) probes.splice(i, 1)
    },
    async upsertUser(email: string): Promise<User> {
      const existing = [...usersMap.values()].find((u) => u.email === email)
      if (existing) return existing
      const u: User = { id: crypto.randomUUID(), email, createdAt: new Date() }
      usersMap.set(u.id, u)
      return u
    },
    async upsertCookie(cookie: string, userId?: string): Promise<Cookie> {
      const existing = cookiesMap.get(cookie)
      if (existing) {
        if (userId !== undefined) {
          const updated: Cookie = { ...existing, userId }
          cookiesMap.set(cookie, updated)
          return updated
        }
        return existing
      }
      const c: Cookie = { cookie, userId: userId ?? null, createdAt: new Date() }
      cookiesMap.set(cookie, c)
      return c
    },
    async getCookie(cookie: string): Promise<Cookie | null> {
      return cookiesMap.get(cookie) ?? null
    },
    async createRecommendations(_rows: NewRecommendation[]): Promise<void> {},
    async listRecommendations(_gradeId: string): Promise<Recommendation[]> { return [] },
    async createReport(input: NewReport): Promise<Report> {
      return { id: crypto.randomUUID(), gradeId: input.gradeId, token: input.token, createdAt: new Date() }
    },
    async getReport(_gradeId: string): Promise<Report | null> { return null },
  }
}
```

### Step 8: Update Plan 5's in-line copies to import this shared helper

Modify `tests/unit/queue/workers/run-grade/categories.test.ts` — delete the inline `makeFakeStore` + `makeStubRedis` + `parseEvents` block at the top. Add:
```ts
import { makeFakeStore } from '../../../../_helpers/fake-store.ts'
```
Keep `makeStubRedis` + `parseEvents` inline for now (they're Plan-5-specific; Plan 6a has its own stub Redis needs and will define its own inline).

Repeat for `tests/unit/queue/workers/run-grade/run-grade.test.ts`.

### Step 9: Run all unit + integration tests; expect baseline 283 unit + 30 integration

Run: `pnpm test`
Expected: 255 from baseline (Plans 1–5) still pass.

Run: `pnpm test:integration tests/integration/store-get-cookie.test.ts`
Expected: PASS (3 tests).

Run: `pnpm typecheck`
Expected: clean.

### Step 10: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add package.json pnpm-lock.yaml src/store/types.ts src/store/postgres.ts tests/integration/store-get-cookie.test.ts tests/unit/_helpers/fake-store.ts tests/unit/queue/workers/run-grade/categories.test.ts tests/unit/queue/workers/run-grade/run-grade.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): GradeStore.getCookie + shared fake-store helper + @hono/zod-validator dep"
```

---

## Task 2 — `ServerDeps` interface + refactor `buildApp`

**Files:**
- Create: `src/server/deps.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/server.ts`
- Modify: `tests/unit/server/healthz.test.ts`

### Step 1: Create `src/server/deps.ts`

```ts
import type Redis from 'ioredis'
import type { GradeStore } from '../store/types.ts'

export interface ServerDeps {
  store: GradeStore
  redis: Redis
  redisFactory: () => Redis
  pingDb: () => Promise<boolean>
  pingRedis: () => Promise<boolean>
  env: { NODE_ENV: 'development' | 'test' | 'production' }
}
```

### Step 2: Rewrite `src/server/app.ts` to take `ServerDeps`

Replace contents of `src/server/app.ts`:
```ts
import { Hono } from 'hono'
import type { ServerDeps } from './deps.ts'

export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono()

  app.get('/healthz', async (c) => {
    const [dbResult, redisResult] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()])
    const db = dbResult.status === 'fulfilled' && dbResult.value === true
    const redis = redisResult.status === 'fulfilled' && redisResult.value === true
    const ok = db && redis
    return c.json({ ok, db, redis }, ok ? 200 : 503)
  })

  return app
}
```

Note: `AppDeps` is gone; `buildApp` now takes `ServerDeps`. New fields (`store`, `redis`, `redisFactory`, `env`) exist on the type but aren't used until later tasks mount routes.

### Step 3: Update `src/server/server.ts` to build `ServerDeps`

Replace contents of `src/server/server.ts`:
```ts
import { serve } from '@hono/node-server'
import { sql } from 'drizzle-orm'
import { env } from '../config/env.ts'
import { db, closeDb } from '../db/client.ts'
import { PostgresStore } from '../store/postgres.ts'
import { createRedis } from '../queue/redis.ts'
import { buildApp } from './app.ts'

const redis = createRedis(env.REDIS_URL)
const store = new PostgresStore(db)

const app = buildApp({
  store,
  redis,
  redisFactory: () => createRedis(env.REDIS_URL),
  pingDb: async () => {
    try { await db.execute(sql`select 1`); return true } catch { return false }
  },
  pingRedis: async () => (await redis.ping()) === 'PONG',
  env: { NODE_ENV: env.NODE_ENV },
})

const server = serve({ fetch: app.fetch, port: env.PORT })
console.log(JSON.stringify({ msg: 'server listening', port: env.PORT }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'server shutting down', signal }))
  server.close()
  await redis.quit()
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

### Step 4: Update `tests/unit/server/healthz.test.ts` for new deps shape

Replace contents:
```ts
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../../src/server/app.ts'
import type { ServerDeps } from '../../../src/server/deps.ts'
import { makeFakeStore } from '../_helpers/fake-store.ts'
import type Redis from 'ioredis'

function makeStubRedis(): Redis {
  return {} as unknown as Redis
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    store: makeFakeStore(),
    redis: makeStubRedis(),
    redisFactory: () => makeStubRedis(),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: { NODE_ENV: 'test' },
    ...overrides,
  }
}

describe('/healthz (unit)', () => {
  it('returns ok when both deps are healthy', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: true, redis: true })
  })

  it('returns 503 when db fails', async () => {
    const app = buildApp(makeDeps({ pingDb: async () => false }))
    const res = await app.request('/healthz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; db: boolean; redis: boolean }
    expect(body.ok).toBe(false)
    expect(body.db).toBe(false)
  })

  it('returns 503 when redis throws', async () => {
    const app = buildApp(makeDeps({ pingRedis: async () => { throw new Error('boom') } }))
    const res = await app.request('/healthz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; db: boolean; redis: boolean }
    expect(body.redis).toBe(false)
  })
})
```

### Step 5: Run tests + typecheck

Run: `pnpm test tests/unit/server/healthz.test.ts`
Expected: PASS (3 tests).

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Also check the existing healthz integration test (`tests/integration/healthz.test.ts`) still passes

Run: `pnpm test:integration tests/integration/healthz.test.ts`
Expected: PASS. If it fails because it was constructing a bare `{pingDb, pingRedis}` style deps, update it to use the new shape.

Read the existing file first, then adjust. The change is parallel to the unit-test change in Step 4.

### Step 7: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/server/deps.ts src/server/app.ts src/server/server.ts tests/unit/server/healthz.test.ts tests/integration/healthz.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): ServerDeps interface + refactor buildApp around it"
```

---

## Task 3 — `client-ip` middleware

**Files:**
- Create: `src/server/middleware/client-ip.ts`
- Create: `tests/unit/server/middleware/client-ip.test.ts`

### Step 1: Write failing test

Create `tests/unit/server/middleware/client-ip.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

describe('clientIp middleware', () => {
  function buildTestApp(): Hono<{ Variables: { clientIp: string } }> {
    const app = new Hono<{ Variables: { clientIp: string } }>()
    app.use('*', clientIp())
    app.get('/', (c) => c.json({ ip: c.var.clientIp }))
    return app
  }

  it('returns the X-Forwarded-For value when present', async () => {
    const app = buildTestApp()
    const res = await app.request('/', { headers: { 'x-forwarded-for': '203.0.113.5' } })
    expect(await res.json()).toEqual({ ip: '203.0.113.5' })
  })

  it('returns the first entry of a comma-separated X-Forwarded-For list', async () => {
    const app = buildTestApp()
    const res = await app.request('/', { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 192.168.1.1' } })
    expect(await res.json()).toEqual({ ip: '203.0.113.5' })
  })

  it('trims whitespace around the X-Forwarded-For value', async () => {
    const app = buildTestApp()
    const res = await app.request('/', { headers: { 'x-forwarded-for': '   203.0.113.5   , 10.0.0.1' } })
    expect(await res.json()).toEqual({ ip: '203.0.113.5' })
  })

  it('falls back to 0.0.0.0 when XFF is absent and no socket info is available', async () => {
    const app = buildTestApp()
    const res = await app.request('/')
    expect(await res.json()).toEqual({ ip: '0.0.0.0' })
  })
})
```

### Step 2: Run; expect FAIL (module missing)

Run: `pnpm test tests/unit/server/middleware/client-ip.test.ts`
Expected: FAIL.

### Step 3: Implement `src/server/middleware/client-ip.ts`

```ts
import type { MiddlewareHandler } from 'hono'

type Env = { Variables: { clientIp: string } }

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } }
}

export function clientIp(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const xff = c.req.header('x-forwarded-for')
    const fromXff = xff?.split(',')[0]?.trim()
    const fromSocket = (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress
    const ip = fromXff || fromSocket || '0.0.0.0'
    c.set('clientIp', ip)
    await next()
  }
}
```

### Step 4: Run tests; expect 4 PASS

Run: `pnpm test tests/unit/server/middleware/client-ip.test.ts`
Expected: PASS (4 tests).

Run: `pnpm typecheck`
Expected: clean.

### Step 5: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/server/middleware/client-ip.ts tests/unit/server/middleware/client-ip.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): client-ip middleware (XFF-first, socket fallback)"
```

---

## Task 4 — `cookie` middleware

**Files:**
- Create: `src/server/middleware/cookie.ts`
- Create: `tests/unit/server/middleware/cookie.test.ts`

### Step 1: Write failing test

Create `tests/unit/server/middleware/cookie.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'

describe('cookie middleware', () => {
  function buildTestApp(isProduction = false) {
    const store = makeFakeStore()
    const app = new Hono<{ Variables: { cookie: string } }>()
    app.use('*', cookieMiddleware(store, isProduction))
    app.get('/', (c) => c.json({ cookie: c.var.cookie }))
    return { app, store }
  }

  it('issues a new UUID cookie when none present', async () => {
    const { app, store } = buildTestApp()
    const res = await app.request('/')
    const body = (await res.json()) as { cookie: string }
    expect(body.cookie).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toMatch(/^ggcookie=/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toMatch(/Max-Age=\d+/)
    expect(setCookie).not.toContain('Secure')   // not prod
    expect(store.cookiesMap.size).toBe(1)
  })

  it('includes Secure when isProduction=true', async () => {
    const { app } = buildTestApp(true)
    const res = await app.request('/')
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('Secure')
  })

  it('reuses an existing cookie and does not re-issue', async () => {
    const { app, store } = buildTestApp()
    const preset = '11111111-2222-3333-4444-555555555555'
    await store.upsertCookie(preset)
    const res = await app.request('/', { headers: { cookie: `ggcookie=${preset}` } })
    const body = (await res.json()) as { cookie: string }
    expect(body.cookie).toBe(preset)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(store.cookiesMap.size).toBe(1)   // no new rows
  })

  it('calls upsertCookie exactly once on issuance', async () => {
    const { app, store } = buildTestApp()
    await app.request('/')
    await app.request('/', { headers: { cookie: `ggcookie=${[...store.cookiesMap.keys()][0]}` } })
    // First request: upsertCookie called once (issuance).
    // Second request: cookie exists, no upsert.
    expect(store.cookiesMap.size).toBe(1)
  })
})
```

### Step 2: Run; expect FAIL

Run: `pnpm test tests/unit/server/middleware/cookie.test.ts`
Expected: FAIL.

### Step 3: Implement `src/server/middleware/cookie.ts`

```ts
import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { GradeStore } from '../../store/types.ts'

export const COOKIE_NAME = 'ggcookie'
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

type Env = { Variables: { cookie: string } }

export function cookieMiddleware(store: GradeStore, isProduction: boolean): MiddlewareHandler<Env> {
  return async (c, next) => {
    let cookie = getCookie(c, COOKIE_NAME)
    if (!cookie) {
      cookie = crypto.randomUUID()
      await store.upsertCookie(cookie)
      setCookie(c, COOKIE_NAME, cookie, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: isProduction,
        path: '/',
        maxAge: ONE_YEAR_SECONDS,
      })
    }
    c.set('cookie', cookie)
    await next()
  }
}
```

### Step 4: Run tests; expect 4 PASS

Run: `pnpm test tests/unit/server/middleware/cookie.test.ts`
Expected: PASS (4 tests).

Run: `pnpm typecheck`
Expected: clean.

### Step 5: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/server/middleware/cookie.ts tests/unit/server/middleware/cookie.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): cookie middleware (issue UUID, upsertCookie, set httpOnly/Lax)"
```

---

## Task 5 — `rate-limit` middleware

**Files:**
- Create: `src/server/middleware/rate-limit.ts`
- Create: `tests/unit/server/middleware/rate-limit.test.ts`

### Step 1: Write failing test

Create `tests/unit/server/middleware/rate-limit.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { checkRateLimit } from '../../../../src/server/middleware/rate-limit.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import type Redis from 'ioredis'

// Stub Redis supporting sorted-set operations + ttl.
function makeStubRedis(): Redis {
  const zsets = new Map<string, { score: number; member: string }[]>()
  const ttls = new Map<string, number>()
  const stub = {
    async zadd(key: string, score: number, member: string): Promise<number> {
      const arr = zsets.get(key) ?? []
      arr.push({ score, member })
      zsets.set(key, arr)
      return 1
    },
    async zcard(key: string): Promise<number> { return (zsets.get(key) ?? []).length },
    async zremrangebyscore(key: string, _min: string, max: string): Promise<number> {
      const arr = zsets.get(key) ?? []
      const cutoff = Number(max)
      const kept = arr.filter((e) => e.score > cutoff)
      zsets.set(key, kept)
      return arr.length - kept.length
    },
    async zrange(key: string, start: number, stop: number, _withscores?: string): Promise<string[]> {
      const arr = [...(zsets.get(key) ?? [])].sort((a, b) => a.score - b.score)
      const slice = arr.slice(start, stop + 1)
      // WITHSCORES format: [member, score, member, score, ...]
      const flat: string[] = []
      for (const e of slice) { flat.push(e.member, String(e.score)) }
      return flat
    },
    async expire(key: string, seconds: number): Promise<number> {
      ttls.set(key, seconds)
      return 1
    },
    __debug: { zsets, ttls },
  }
  return stub as unknown as Redis
}

const now = 1_700_000_000_000   // fixed ms epoch for determinism

describe('checkRateLimit', () => {
  it('allows the first request for an anonymous cookie', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const redis = makeStubRedis()
    const result = await checkRateLimit(redis, store, '203.0.113.1', 'c-1', now)
    expect(result).toEqual({ allowed: true, limit: 3, used: 1, retryAfter: 0 })
  })

  it('blocks the 4th anonymous request within 24h with retryAfter = age-until-oldest-expires', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-2')
    const redis = makeStubRedis()
    await checkRateLimit(redis, store, '203.0.113.2', 'c-2', now)
    await checkRateLimit(redis, store, '203.0.113.2', 'c-2', now + 1000)
    await checkRateLimit(redis, store, '203.0.113.2', 'c-2', now + 2000)
    const fourth = await checkRateLimit(redis, store, '203.0.113.2', 'c-2', now + 3000)
    expect(fourth.allowed).toBe(false)
    expect(fourth.limit).toBe(3)
    expect(fourth.used).toBe(3)
    // Oldest entry was at `now`; fourth checked at `now + 3000ms`.
    // Window is 86400000ms; oldest expires at `now + 86400000`.
    // retryAfter = ceil((now + 86400000 - (now + 3000)) / 1000) = ceil(86397) = 86397
    expect(fourth.retryAfter).toBe(86397)
  })

  it('allows the 4th request after the oldest entry falls out of the 24h window', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-3')
    const redis = makeStubRedis()
    await checkRateLimit(redis, store, '203.0.113.3', 'c-3', now)
    await checkRateLimit(redis, store, '203.0.113.3', 'c-3', now + 1000)
    await checkRateLimit(redis, store, '203.0.113.3', 'c-3', now + 2000)
    // Now jump 24h + 1s — the oldest entry at `now` falls out.
    const later = now + 86_401_000
    const result = await checkRateLimit(redis, store, '203.0.113.3', 'c-3', later)
    expect(result.allowed).toBe(true)
    // After ZREMRANGEBYSCORE drops the oldest, 2 remain in-window; this becomes the 3rd.
    expect(result.used).toBe(3)
  })

  it('gives email-verified cookies limit=13', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('verified@example.com')
    await store.upsertCookie('c-4', user.id)
    const redis = makeStubRedis()
    const result = await checkRateLimit(redis, store, '203.0.113.4', 'c-4', now)
    expect(result.allowed).toBe(true)
    expect(result.limit).toBe(13)
  })

  it('blocks the 14th verified request', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('heavy@example.com')
    await store.upsertCookie('c-5', user.id)
    const redis = makeStubRedis()
    for (let i = 0; i < 13; i++) {
      await checkRateLimit(redis, store, '203.0.113.5', 'c-5', now + i * 1000)
    }
    const fourteenth = await checkRateLimit(redis, store, '203.0.113.5', 'c-5', now + 13_000)
    expect(fourteenth.allowed).toBe(false)
    expect(fourteenth.limit).toBe(13)
    expect(fourteenth.used).toBe(13)
  })

  it('treats the same cookie from different IPs as independent buckets', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-6')
    const redis = makeStubRedis()
    // 3 from IP A
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(redis, store, '203.0.113.6', 'c-6', now + i)
      expect(r.allowed).toBe(true)
    }
    // A 4th from IP A is blocked
    const blocked = await checkRateLimit(redis, store, '203.0.113.6', 'c-6', now + 4)
    expect(blocked.allowed).toBe(false)
    // But the same cookie from IP B starts fresh
    const fresh = await checkRateLimit(redis, store, '203.0.113.77', 'c-6', now + 5)
    expect(fresh.allowed).toBe(true)
    expect(fresh.used).toBe(1)
  })

  it('sets a 24h expire on the bucket key', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-7')
    const redis = makeStubRedis()
    await checkRateLimit(redis, store, '203.0.113.7', 'c-7', now)
    // @ts-expect-error — accessing stub debug
    const ttls = (redis as { __debug: { ttls: Map<string, number> } }).__debug.ttls
    expect(ttls.get('bucket:ip:203.0.113.7+cookie:c-7')).toBe(86400)
  })

  it('treats an unknown cookie (no DB row) as anonymous limit=3', async () => {
    const store = makeFakeStore()
    // Deliberately do NOT upsertCookie — cookie middleware ensures row exists
    // in production, but checkRateLimit must be defensive.
    const redis = makeStubRedis()
    const result = await checkRateLimit(redis, store, '203.0.113.8', 'c-unknown', now)
    expect(result.limit).toBe(3)
    expect(result.allowed).toBe(true)
  })
})
```

### Step 2: Run; expect FAIL

Run: `pnpm test tests/unit/server/middleware/rate-limit.test.ts`
Expected: FAIL.

### Step 3: Implement `src/server/middleware/rate-limit.ts`

```ts
import type { MiddlewareHandler } from 'hono'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'

const WINDOW_MS = 86_400_000   // 24h
const EXPIRE_SECONDS = 86_400

const ANON_LIMIT = 3
const VERIFIED_LIMIT = 13

export interface RateLimitResult {
  allowed: boolean
  limit: number
  used: number
  retryAfter: number
}

function bucketKey(ip: string, cookie: string): string {
  return `bucket:ip:${ip}+cookie:${cookie}`
}

export async function checkRateLimit(
  redis: Redis,
  store: GradeStore,
  ip: string,
  cookie: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const row = await store.getCookie(cookie)
  const limit = row?.userId ? VERIFIED_LIMIT : ANON_LIMIT
  const key = bucketKey(ip, cookie)
  const cutoff = now - WINDOW_MS

  await redis.zremrangebyscore(key, '-inf', String(cutoff))
  const used = await redis.zcard(key)

  if (used >= limit) {
    const range = await redis.zrange(key, 0, 0, 'WITHSCORES')
    const oldestScore = range.length >= 2 ? Number(range[1]) : now
    const retryAfter = Math.ceil((oldestScore + WINDOW_MS - now) / 1000)
    return { allowed: false, limit, used, retryAfter }
  }

  await redis.zadd(key, now, `${now}-${crypto.randomUUID()}`)
  await redis.expire(key, EXPIRE_SECONDS)
  return { allowed: true, limit, used: used + 1, retryAfter: 0 }
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

### Step 4: Run tests; expect 8 PASS

Run: `pnpm test tests/unit/server/middleware/rate-limit.test.ts`
Expected: PASS (8 tests).

Run: `pnpm typecheck`
Expected: clean.

### Step 5: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/server/middleware/rate-limit.ts tests/unit/server/middleware/rate-limit.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): rate-limit middleware (Redis sorted-set bucket, 3 anon / 13 verified)"
```

---

## Task 6 — `grades.ts` routes (POST + GET) + app composition

**Files:**
- Create: `src/server/routes/grades.ts`
- Modify: `src/server/app.ts` (compose middleware + mount grades routes)
- Create: `tests/unit/server/routes/grades.test.ts`

### Step 1: Write failing test

Create `tests/unit/server/routes/grades.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../../../src/server/app.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import type { ServerDeps } from '../../../../src/server/deps.ts'
import type Redis from 'ioredis'

function makeStubRedis() {
  const stub = {
    async publish() { return 1 },
    async zadd() { return 1 },
    async zcard() { return 0 },
    async zremrangebyscore() { return 0 },
    async zrange() { return [] as string[] },
    async expire() { return 1 },
  }
  return stub as unknown as Redis
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    store: makeFakeStore(),
    redis: makeStubRedis(),
    redisFactory: () => makeStubRedis(),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: { NODE_ENV: 'test' },
    ...overrides,
  }
}

describe('POST /grades', () => {
  it('returns 202 with gradeId on valid body, creates grade row, calls enqueueGrade equivalent (ZADD on grade queue)', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const res = await app.request('/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://acme.com/page' }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { gradeId: string }
    expect(body.gradeId).toMatch(/^[0-9a-f-]{36}$/)
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const grade = store.gradesMap.get(body.gradeId)
    expect(grade).toBeDefined()
    expect(grade?.url).toBe('https://acme.com/page')
    expect(grade?.domain).toBe('acme.com')
    expect(grade?.tier).toBe('free')
    expect(grade?.status).toBe('queued')
    expect(grade?.cookie).toBeTruthy()
  })

  it('strips leading www. from domain', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.acme.com/' }),
    })
    const body = (await res.json()) as { gradeId: string }
    const store = deps.store as ReturnType<typeof makeFakeStore>
    expect(store.gradesMap.get(body.gradeId)?.domain).toBe('acme.com')
  })

  it('returns 400 for missing body', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-URL string', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'not a url' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-http scheme', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://example.com/' }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts http:// URLs', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://acme.com' }),
    })
    expect(res.status).toBe(202)
  })
})

describe('GET /grades/:id', () => {
  it('returns the grade JSON for the owning cookie', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const created = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://acme.com' }),
    })
    const { gradeId } = (await created.json()) as { gradeId: string }
    const setCookie = created.headers.get('set-cookie')
    const cookieHeader = setCookie?.split(';')[0] ?? ''

    const res = await app.request(`/grades/${gradeId}`, { headers: { cookie: cookieHeader } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; url: string; tier: string; status: string }
    expect(body.id).toBe(gradeId)
    expect(body.url).toBe('https://acme.com')
    expect(body.tier).toBe('free')
    expect(body.status).toBe('queued')
  })

  it('returns 403 when cookie does not own the grade', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const created = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://acme.com' }),
    })
    const { gradeId } = (await created.json()) as { gradeId: string }
    // Request with a different cookie → new cookie issued, doesn't match
    const res = await app.request(`/grades/${gradeId}`, {
      headers: { cookie: 'ggcookie=11111111-2222-3333-4444-555555555555' },
    })
    expect(res.status).toBe(403)
  })

  it('returns 404 for unknown grade', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  it('returns 400 for a malformed id', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades/not-a-uuid')
    expect(res.status).toBe(400)
  })
})
```

### Step 2: Run; expect FAIL

Run: `pnpm test tests/unit/server/routes/grades.test.ts`
Expected: FAIL — route not mounted.

### Step 3: Implement `src/server/routes/grades.ts`

```ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { enqueueGrade } from '../../queue/queues.ts'
import type { ServerDeps } from '../deps.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CreateGradeBody = z.object({
  url: z.string().url().refine(
    (u) => {
      try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:' } catch { return false }
    },
    { message: 'url must be http:// or https://' },
  ),
})

type Env = { Variables: { cookie: string; clientIp: string } }

export function gradesRouter(deps: ServerDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post('/', zValidator('json', CreateGradeBody), async (c) => {
    const { url } = c.req.valid('json')
    const parsed = new URL(url)
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const grade = await deps.store.createGrade({
      url, domain, tier: 'free', cookie: c.var.cookie, userId: null, status: 'queued',
    })
    await enqueueGrade({ gradeId: grade.id, tier: 'free' }, deps.redis)
    return c.json({ gradeId: grade.id }, 202)
  })

  app.get('/:id', async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400)
    const grade = await deps.store.getGrade(id)
    if (!grade) return c.json({ error: 'not found' }, 404)
    if (grade.cookie !== c.var.cookie) return c.json({ error: 'forbidden' }, 403)
    return c.json({
      id: grade.id,
      url: grade.url,
      domain: grade.domain,
      tier: grade.tier,
      status: grade.status,
      overall: grade.overall,
      letter: grade.letter,
      scores: grade.scores,
      createdAt: grade.createdAt,
      updatedAt: grade.updatedAt,
    })
  })

  return app
}
```

### Step 4: Update `src/server/app.ts` to compose middleware and mount routes

Replace contents of `src/server/app.ts`:
```ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ServerDeps } from './deps.ts'
import { clientIp } from './middleware/client-ip.ts'
import { cookieMiddleware } from './middleware/cookie.ts'
import { rateLimitMiddleware } from './middleware/rate-limit.ts'
import { gradesRouter } from './routes/grades.ts'

export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono()

  app.get('/healthz', async (c) => {
    const [dbResult, redisResult] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()])
    const db = dbResult.status === 'fulfilled' && dbResult.value === true
    const redis = redisResult.status === 'fulfilled' && redisResult.value === true
    const ok = db && redis
    return c.json({ ok, db, redis }, ok ? 200 : 503)
  })

  if (deps.env.NODE_ENV === 'development') {
    app.use('*', cors({ origin: 'http://localhost:5173', credentials: true }))
  }

  const gradeScope = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  gradeScope.use('*', clientIp(), cookieMiddleware(deps.store, deps.env.NODE_ENV === 'production'))
  gradeScope.post('/', rateLimitMiddleware(deps.redis, deps.store))
  gradeScope.route('/', gradesRouter(deps))

  app.route('/grades', gradeScope)
  return app
}
```

### Step 5: Run tests

Run: `pnpm test tests/unit/server/routes/grades.test.ts`
Expected: PASS (~10 tests).

Run: `pnpm test tests/unit/server/healthz.test.ts`
Expected: PASS (3 tests) — healthz still works, middleware doesn't touch it.

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/server/routes/grades.ts src/server/app.ts tests/unit/server/routes/grades.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): POST /grades + GET /grades/:id routes + middleware composition"
```

---

## Task 7 — `grades-events.ts` SSE route (early-exit paths)

**Files:**
- Create: `src/server/routes/grades-events.ts`
- Modify: `src/server/app.ts` (mount the events route)
- Create: `tests/unit/server/routes/grades-events.test.ts`

### Step 1: Write failing test

Create `tests/unit/server/routes/grades-events.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../../../src/server/app.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import type { ServerDeps } from '../../../../src/server/deps.ts'
import type Redis from 'ioredis'

function makeStubRedis() {
  return { async publish() { return 1 } } as unknown as Redis
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    store: makeFakeStore(),
    redis: makeStubRedis(),
    redisFactory: () => makeStubRedis(),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: { NODE_ENV: 'test' },
    ...overrides,
  }
}

describe('GET /grades/:id/events (unit — early exit paths)', () => {
  it('returns 400 for malformed id', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades/not-a-uuid/events')
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown grade', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades/00000000-0000-0000-0000-000000000000/events')
    expect(res.status).toBe(404)
  })

  it('returns 403 when cookie does not own the grade', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    await store.upsertCookie('owning-cookie')
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free',
      cookie: 'owning-cookie', userId: null, status: 'queued',
    })
    const app = buildApp(deps)
    const res = await app.request(`/grades/${grade.id}/events`, {
      headers: { cookie: 'ggcookie=11111111-2222-3333-4444-555555555555' },
    })
    expect(res.status).toBe(403)
  })

  it('emits one synthesized done event for a done grade and closes the stream', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const cookieValue = '22222222-3333-4444-5555-666666666666'
    await store.upsertCookie(cookieValue)
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free',
      cookie: cookieValue, userId: null, status: 'done',
      overall: 85, letter: 'B', scores: { discoverability: 90, recognition: 80, accuracy: 75, coverage: 85, citation: 100, seo: 80 },
    })
    const app = buildApp(deps)
    const res = await app.request(`/grades/${grade.id}/events`, {
      headers: { cookie: `ggcookie=${cookieValue}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await res.text()
    // SSE format: lines beginning with `data: `.
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
    expect(dataLines).toHaveLength(1)
    expect(dataLines[0]).toMatchObject({ type: 'done', overall: 85, letter: 'B' })
  })

  it('emits one synthesized failed event for a failed grade', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const cookieValue = '33333333-4444-5555-6666-777777777777'
    await store.upsertCookie(cookieValue)
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free',
      cookie: cookieValue, userId: null, status: 'failed',
    })
    const app = buildApp(deps)
    const res = await app.request(`/grades/${grade.id}/events`, {
      headers: { cookie: `ggcookie=${cookieValue}` },
    })
    const text = await res.text()
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
    expect(dataLines).toHaveLength(1)
    expect(dataLines[0]).toMatchObject({ type: 'failed' })
  })
})
```

### Step 2: Run; expect FAIL

Run: `pnpm test tests/unit/server/routes/grades-events.test.ts`
Expected: FAIL — route not mounted.

### Step 3: Implement `src/server/routes/grades-events.ts`

```ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { subscribeToGrade, type GradeEvent } from '../../queue/events.ts'
import type { CategoryId } from '../../scoring/weights.ts'
import type { ProviderId } from '../../llm/providers/types.ts'
import type { ServerDeps } from '../deps.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Env = { Variables: { cookie: string; clientIp: string } }

export function gradesEventsRouter(deps: ServerDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.get('/:id/events', async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400)
    const grade = await deps.store.getGrade(id)
    if (!grade) return c.json({ error: 'not found' }, 404)
    if (grade.cookie !== c.var.cookie) return c.json({ error: 'forbidden' }, 403)

    return streamSSE(c, async (stream) => {
      const send = async (ev: GradeEvent): Promise<void> => {
        await stream.writeSSE({ data: JSON.stringify(ev) })
      }

      // 1. Terminal statuses: emit synthesized terminal event and close.
      if (grade.status === 'done') {
        await send({
          type: 'done',
          overall: grade.overall ?? 0,
          letter: grade.letter ?? 'F',
          scores: (grade.scores ?? {}) as Record<CategoryId, number | null>,
        })
        return
      }
      if (grade.status === 'failed') {
        await send({ type: 'failed', error: 'grade failed' })
        return
      }

      // 2. Non-terminal: hydrate past state from DB, then subscribe live.
      await send({ type: 'running' })
      const scrape = await deps.store.getScrape(grade.id)
      if (scrape) {
        await send({ type: 'scraped', rendered: scrape.rendered, textLength: scrape.text.length })
      }
      const probes = await deps.store.listProbes(grade.id)
      // listProbes may return in desc order; sort ascending by createdAt for replay.
      const ordered = [...probes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      for (const probe of ordered) {
        const meta = (probe.metadata ?? {}) as { label?: string; latencyMs?: number; error?: string | null }
        await send({
          type: 'probe.completed',
          category: probe.category as CategoryId,
          provider: probe.provider as ProviderId | null,
          label: meta.label ?? '',
          score: probe.score,
          durationMs: meta.latencyMs ?? 0,
          error: meta.error ?? null,
        })
      }

      // 3. Subscribe to live Redis events.
      const subscriber = deps.redisFactory()
      const abortCtrl = new AbortController()
      const onAbort = (): void => abortCtrl.abort()
      c.req.raw.signal.addEventListener('abort', onAbort, { once: true })

      try {
        for await (const event of subscribeToGrade(subscriber, grade.id, abortCtrl.signal)) {
          await send(event)
          if (event.type === 'done' || event.type === 'failed') break
        }
      } finally {
        c.req.raw.signal.removeEventListener('abort', onAbort)
        await subscriber.quit()
      }
    })
  })

  return app
}
```

### Step 4: Update `src/server/app.ts` to mount the SSE route

Modify the gradeScope block in `src/server/app.ts`:
```ts
import { gradesEventsRouter } from './routes/grades-events.ts'
// ...
  gradeScope.route('/', gradesRouter(deps))
  gradeScope.route('/', gradesEventsRouter(deps))
```

### Step 5: Run tests

Run: `pnpm test tests/unit/server/routes/grades-events.test.ts`
Expected: PASS (5 tests).

Run: `pnpm test`
Expected: all existing unit tests still pass.

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/server/routes/grades-events.ts src/server/app.ts tests/unit/server/routes/grades-events.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): GET /grades/:id/events SSE route with DB hydration + Redis subscribe"
```

---

## Task 8 — Integration test: rate-limit lifecycle

**Files:**
- Create: `tests/integration/server/rate-limit.test.ts`

### Step 1: Create the test

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { createRedis } from '../../../src/queue/redis.ts'
import { PostgresStore } from '../../../src/store/postgres.ts'
import { checkRateLimit } from '../../../src/server/middleware/rate-limit.ts'
import { startTestDb, type TestDb } from '../setup.ts'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  testDb = await startTestDb()
}, 120_000)

afterAll(async () => {
  await testDb.stop()
  await redisContainer.stop()
})

describe('rate-limit (integration)', () => {
  it('allows 3 anonymous requests, blocks the 4th', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const cookie = `anon-${Date.now()}`
    await store.upsertCookie(cookie)

    const ip = '203.0.113.100'
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(redis, store, ip, cookie)
      expect(r.allowed).toBe(true)
    }
    const blocked = await checkRateLimit(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(3)
    expect(blocked.retryAfter).toBeGreaterThan(0)

    await redis.quit()
  })

  it('verified cookies (userId set) get limit=13', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const user = await store.upsertUser(`rl-${Date.now()}@example.com`)
    const cookie = `verified-${Date.now()}`
    await store.upsertCookie(cookie, user.id)

    const ip = '203.0.113.101'
    for (let i = 0; i < 13; i++) {
      const r = await checkRateLimit(redis, store, ip, cookie)
      expect(r.allowed).toBe(true)
      expect(r.limit).toBe(13)
    }
    const blocked = await checkRateLimit(redis, store, ip, cookie)
    expect(blocked.allowed).toBe(false)
    expect(blocked.limit).toBe(13)

    await redis.quit()
  })

  it('different IP + same cookie gets an independent bucket', async () => {
    const redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const cookie = `shared-${Date.now()}`
    await store.upsertCookie(cookie)

    for (let i = 0; i < 3; i++) {
      await checkRateLimit(redis, store, '203.0.113.200', cookie)
    }
    const blocked = await checkRateLimit(redis, store, '203.0.113.200', cookie)
    expect(blocked.allowed).toBe(false)

    const fresh = await checkRateLimit(redis, store, '203.0.113.201', cookie)
    expect(fresh.allowed).toBe(true)
    expect(fresh.used).toBe(1)

    await redis.quit()
  })
})
```

### Step 2: Run; expect 3 PASS

Run: `pnpm test:integration tests/integration/server/rate-limit.test.ts`
Expected: PASS (3 tests). First run takes ~20s for containers.

### Step 3: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add tests/integration/server/rate-limit.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(v3): rate-limit integration test with testcontainers"
```

---

## Task 9 — Integration test: full SSE lifecycle with real HTTP + in-process worker

**Files:**
- Create: `tests/integration/server/grades-events-live.test.ts`

### Step 1: Create the test

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { serve, type ServerType } from '@hono/node-server'
import { AddressInfo } from 'node:net'
import { createRedis } from '../../../src/queue/redis.ts'
import { PostgresStore } from '../../../src/store/postgres.ts'
import { buildApp } from '../../../src/server/app.ts'
import { registerRunGradeWorker } from '../../../src/queue/workers/run-grade/index.ts'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { startTestDb, type TestDb } from '../setup.ts'
import type { ScrapeResult } from '../../../src/scraper/index.ts'
import type { Worker as BullMqWorker } from 'bullmq'

let redisContainer: StartedTestContainer
let redisUrl: string
let testDb: TestDb

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  testDb = await startTestDb()
}, 120_000)

afterAll(async () => {
  await testDb.stop()
  await redisContainer.stop()
})

const FIXTURE_SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: ('Acme widgets since 1902. Family-owned. Global distribution. ').repeat(10),
  structured: {
    jsonld: [],
    og: { title: 'Acme', description: 'Widgets', image: 'https://acme.com/og.png' },
    meta: { title: 'Acme Widgets', description: 'Industrial widgets since 1902.', canonical: 'https://acme.com', twitterCard: 'summary' },
    headings: { h1: ['Welcome'], h2: ['About'] },
    robots: null,
    sitemap: { present: true, url: 'https://acme.com/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
  },
}

function happyClaude(): MockProvider {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
      if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
      if (prompt.includes('You are evaluating how well')) return JSON.stringify({
        probe_1: { accuracy: 80, coverage: 75, notes: '' },
        probe_2: { accuracy: 70, coverage: 65, notes: '' },
        probe_3: { accuracy: 75, coverage: 70, notes: '' },
        probe_4: { accuracy: 65, coverage: 60, notes: '' },
      })
      if (prompt.includes('Do NOT reference')) return 'Which widget is best?'
      return 'Acme is the leading widget maker.'
    },
  })
}

function happyGpt(): MockProvider {
  return new MockProvider({
    id: 'gpt',
    responses: (prompt) => prompt.includes('Do NOT reference') ? 'Which brand leads?' : 'Acme is the go-to widget brand.',
  })
}

async function readSseUntilDone(
  response: Response,
  timeoutMs = 30_000,
): Promise<{ type: string; [k: string]: unknown }[]> {
  const events: { type: string; [k: string]: unknown }[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE events are separated by blank lines
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      const event = JSON.parse(dataLine.slice(6)) as { type: string }
      events.push(event)
      if (event.type === 'done' || event.type === 'failed') {
        await reader.cancel()
        return events
      }
    }
  }
  await reader.cancel()
  throw new Error(`SSE timed out after ${timeoutMs}ms (received ${events.length} events)`)
}

describe('SSE live lifecycle (integration)', () => {
  it('full run: POST /grades → open SSE → see running → scraped → probes → done', async () => {
    const serverRedis = createRedis(redisUrl)
    const workerRedis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const providers = {
      claude: happyClaude(), gpt: happyGpt(),
      gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
      perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
    }
    const worker = registerRunGradeWorker(
      { store, redis: workerRedis, providers, scrapeFn: async () => FIXTURE_SCRAPE },
      workerRedis,
    )

    const app = buildApp({
      store, redis: serverRedis,
      redisFactory: () => createRedis(redisUrl),
      pingDb: async () => true,
      pingRedis: async () => true,
      env: { NODE_ENV: 'test' },
    })
    const server: ServerType = serve({ fetch: app.fetch, port: 0 })
    const port = (server.address() as AddressInfo).port
    const baseUrl = `http://localhost:${port}`

    try {
      // 1. POST /grades
      const createRes = await fetch(`${baseUrl}/grades`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://acme.com' }),
      })
      expect(createRes.status).toBe(202)
      const { gradeId } = (await createRes.json()) as { gradeId: string }
      const setCookie = createRes.headers.get('set-cookie')
      const cookieHeader = setCookie?.split(';')[0] ?? ''

      // 2. Open SSE with the same cookie
      const sseRes = await fetch(`${baseUrl}/grades/${gradeId}/events`, {
        headers: { cookie: cookieHeader, accept: 'text/event-stream' },
      })
      expect(sseRes.status).toBe(200)

      // 3. Drain events until 'done'
      const events = await readSseUntilDone(sseRes, 45_000)
      expect(events[0]?.type).toBe('running')
      const scraped = events.find((e) => e.type === 'scraped')
      expect(scraped).toBeDefined()
      expect(events.filter((e) => e.type === 'probe.completed').length).toBeGreaterThan(20)
      expect(events.filter((e) => e.type === 'category.completed')).toHaveLength(6)
      expect(events[events.length - 1]?.type).toBe('done')

      // 4. Also verify GET /grades/:id now returns a done grade
      const finalRes = await fetch(`${baseUrl}/grades/${gradeId}`, { headers: { cookie: cookieHeader } })
      expect(finalRes.status).toBe(200)
      const final = (await finalRes.json()) as { status: string; overall: number; letter: string }
      expect(final.status).toBe('done')
      expect(typeof final.overall).toBe('number')
      expect(final.letter).toBeTruthy()
    } finally {
      await worker.close()
      server.close()
      await serverRedis.quit()
      await workerRedis.quit()
    }
  }, 60_000)

  it('reconnect: hydrates past state from DB after closing mid-stream', async () => {
    const serverRedis = createRedis(redisUrl)
    const workerRedis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)
    const providers = {
      claude: happyClaude(), gpt: happyGpt(),
      gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
      perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
    }
    const worker = registerRunGradeWorker(
      { store, redis: workerRedis, providers, scrapeFn: async () => FIXTURE_SCRAPE },
      workerRedis,
    )

    const app = buildApp({
      store, redis: serverRedis,
      redisFactory: () => createRedis(redisUrl),
      pingDb: async () => true,
      pingRedis: async () => true,
      env: { NODE_ENV: 'test' },
    })
    const server: ServerType = serve({ fetch: app.fetch, port: 0 })
    const port = (server.address() as AddressInfo).port
    const baseUrl = `http://localhost:${port}`

    try {
      // POST
      const createRes = await fetch(`${baseUrl}/grades`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://acme.com' }),
      })
      const { gradeId } = (await createRes.json()) as { gradeId: string }
      const cookieHeader = (createRes.headers.get('set-cookie')?.split(';')[0]) ?? ''

      // First SSE connection — drain to completion so the grade is fully processed.
      const firstRes = await fetch(`${baseUrl}/grades/${gradeId}/events`, {
        headers: { cookie: cookieHeader, accept: 'text/event-stream' },
      })
      await readSseUntilDone(firstRes, 45_000)

      // Reconnect AFTER the grade is done. Should hydrate DB state and immediately emit `done`.
      const secondRes = await fetch(`${baseUrl}/grades/${gradeId}/events`, {
        headers: { cookie: cookieHeader, accept: 'text/event-stream' },
      })
      const events = await readSseUntilDone(secondRes, 5_000)
      // For a terminal-status grade, hydration emits exactly one `done` event.
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('done')
    } finally {
      await worker.close()
      server.close()
      await serverRedis.quit()
      await workerRedis.quit()
    }
  }, 60_000)
})
```

### Step 2: Run; expect 2 PASS

Run: `pnpm test:integration tests/integration/server/grades-events-live.test.ts`
Expected: PASS (2 tests). First run takes ~30s including container start + the actual grade pipeline.

### Step 3: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add tests/integration/server/grades-events-live.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(v3): SSE live-lifecycle integration test (HTTP + in-process worker)"
```

---

## Task 10 — Final verification

**Files:** none.

### Step 1: Typecheck

Run: `pnpm typecheck`
Expected: 0 errors.

### Step 2: Full unit test suite

Run: `pnpm test`
Expected: ~283 tests passing (255 baseline + ~28 new from Tasks 2–7).

### Step 3: Full integration test suite

Run: `pnpm test:integration`
Expected: ~33 tests passing (27 baseline + 3 store-get-cookie + 3 rate-limit + 2 SSE-live; ignore `healthz` + `store-clear-artifacts` + pre-existing; implementer should sanity-check by counting).

### Step 4: Build

Run: `pnpm build`
Expected: clean, `dist/server.js` + `dist/worker.js` regenerated.

### Step 5: Manual smoke with dev CLI (optional)

Worth a sanity check if the implementer has time:
```bash
# Terminal 1
pnpm dev:worker

# Terminal 2
pnpm dev:server

# Terminal 3 (requires a recent curl with SSE support; or just fetch)
COOKIE=$(curl -s -c - http://localhost:7777/grades -X POST -H 'content-type: application/json' -d '{"url":"https://stripe.com"}' | grep ggcookie | awk '{print $7}')
GRADE_ID=$(curl -s -b "ggcookie=$COOKIE" http://localhost:7777/grades -X POST -H 'content-type: application/json' -d '{"url":"https://stripe.com"}' | jq -r .gradeId)
curl -N -b "ggcookie=$COOKIE" http://localhost:7777/grades/$GRADE_ID/events
```
You should see the live event stream as the worker processes the grade.

### Step 6: Boundary greps

All should produce NO output:
```bash
grep -RE "from '\.\./worker" src/server/ 2>/dev/null || true
grep -RE "from '\.\./scraper" src/server/ 2>/dev/null || true
grep -R "as any" src/server/ 2>/dev/null || true
grep -R "@ts-ignore\|@ts-expect-error" src/server/ 2>/dev/null || true
```

### Step 7: Report

No code changes unless boundary check found something. Report:
- Typecheck status
- Unit test count
- Integration test count
- Build status
- Any issues

---

## Plan 6a completion checklist

Before marking this plan complete:

- [ ] All 10 tasks committed.
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green (~283).
- [ ] `pnpm test:integration` green (~33).
- [ ] `pnpm build` green.
- [ ] No imports from `src/worker/` or `src/scraper/` in `src/server/**`.
- [ ] No `as any` / `@ts-ignore` in new code.
- [ ] Manual smoke test via dev CLI works (curl or Browser DevTools EventSource).

## Out of scope (reminder)

- React frontend (Plan 6b)
- Auth / magic-link (Plan 7)
- Stripe / paid-tier promotion (Plan 8)
- Report HTML/PDF routes (Plan 9)
- `/my/grades` (Plan 7)
- Rate-limit atomicity (Lua script) — production checklist
- Full SSRF defense — production checklist
- Cookie HMAC signing — production checklist
- Trusted-proxy allow-list for XFF — production checklist
- Observability (OTel tracing, metrics) — Plan 10
