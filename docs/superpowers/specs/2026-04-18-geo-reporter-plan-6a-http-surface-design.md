# GEO Reporter — Plan 6a (HTTP surface) design

> Sub-spec for Plan 6a. Expands master spec §10 (API surface) and §4.3 (end-to-end trace steps 1–4). Plan 6 was split into 6a (backend) + 6b (frontend) during brainstorming on 2026-04-18; this spec covers the backend only.

## 1. Scope

Plan 6a builds the **HTTP surface** for the scoring pipeline: three routes (`POST /grades`, `GET /grades/:id`, `GET /grades/:id/events`), the middleware stack they share (client IP resolution, anonymous cookie issuance, rate limiting), and a dependency-injection pattern that lets `app.fetch`-style unit tests run the whole stack against in-memory fakes.

Backend only. No React frontend — that's Plan 6b. No auth, Stripe, reports, or `/my/grades` — those are Plans 7–9.

## 2. Decisions locked in on 2026-04-18

| # | Decision | Choice | Why |
|---|---|---|---|
| P6a-0 | Plan scope | Split Plan 6 into 6a (backend) + 6b (frontend) | 30-task plan would be the biggest merge yet. Splitting respects Plan 5's landing pattern, lets 6a ship as a `curl`-testable backend, and lets 6b iterate independently. |
| P6a-1 | Anonymous cookie | Plain UUID v4, `httpOnly`, `sameSite=Lax`, `secure` in production, 1-year expiry | A forged cookie's only lever is rate-limit denial of service against a stranger — low-impact. Plan 7 will introduce signed session cookies; doing HMAC now means Plan 7 has to distinguish two cookie schemes. |
| P6a-2 | Client IP | Trust `X-Forwarded-For` first-value when present, else socket address, else `0.0.0.0` | Works for Railway (sets XFF) and localhost (doesn't) without configuration. Trusted-proxy allow-list is on the production checklist for launch hardening. |
| P6a-3 | Email-verified limit lookup | Implemented now — `cookies.userId IS NOT NULL` → limit 13, else limit 3 | Plan 7's only rate-limit change becomes "issue the userId binding in the magic-link verify route"; the middleware auto-upgrades. |
| P6a-4 | 429 response body | `{ paywall: 'email', limit, used, retryAfter }` | `retryAfter` is the oldest-entry age computed from the Redis sorted set — saves frontend a round trip. `paywall` is always `'email'` in Plan 6a (no Plan 7 yet); becomes `'email'` or `'pay'` later. |
| P6a-5 | SSE hydration on connect | Always hydrate — emit synthesized past events (scraped + probe.completed per probe) from DB, then subscribe to Redis for live events | One endpoint, always current state. Frontend doesn't need to cross-reference `GET /grades/:id` for hydration. Redis pub/sub has no replay, so this is the only path. |
| P6a-6 | SSE authorization | Cookie must match `grades.cookie`; 403 otherwise | Matches spec's "cookie" auth. Signed-URL shareability comes with Plan 9 (report routes). |
| P6a-7 | URL validation | Zod + `http:`/`https:` scheme check only | Platform-level egress rules defend against SSRF at the network layer in prod. Full DNS-pinning SSRF defense is on the production checklist — must land before public launch. |
| P6a-8 | Concurrent grades | Allow multiple in-flight per cookie | Rate limit (3/24h anon) is the cap. Redirect-to-in-flight UX is a frontend concern (Plan 6b). |
| P6a-9 | Body validation | `@hono/zod-validator` | Idiomatic Hono pattern, thin wrapper over existing Zod dep, consistent 400 shape across Plans 6a/7/8. |
| P6a-10 | CORS | Allow `http://localhost:5173` with `credentials: true` when `NODE_ENV === 'development'`, no CORS middleware in production | Matches the Vite dev server Plan 6b will use; production serves the bundled frontend from the same origin. |
| P6a-11 | Test strategy | `app.fetch(new Request(...))` for all unit tests; real HTTP via `@hono/node-server` only for the SSE live-events integration test | SSE streaming semantics (backpressure, abort propagation) are hard to fake; everything else is cheaper in-process. |

## 3. Architecture

Plan 6a extends the existing `src/server/` with middleware, routes, and a dep-injection seam. No new top-level directories.

```
src/server/
├── server.ts                    MODIFY — build ServerDeps, call buildApp
├── app.ts                       MODIFY — compose middleware + mount routes
├── deps.ts                      NEW — ServerDeps interface
├── middleware/
│   ├── client-ip.ts             NEW — resolves c.var.clientIp from XFF or socket
│   ├── cookie.ts                NEW — issues ggcookie if missing, upsertCookie, sets c.var.cookie
│   └── rate-limit.ts            NEW — Redis sorted-set bucket, 3 anon / 13 verified, 429 with retryAfter
└── routes/
    ├── grades.ts                NEW — POST /grades + GET /grades/:id
    └── grades-events.ts         NEW — GET /grades/:id/events (SSE)

src/store/
├── types.ts                     MODIFY — add getCookie to GradeStore interface
└── postgres.ts                  MODIFY — implement getCookie

package.json                     MODIFY — add @hono/zod-validator dependency

tests/unit/server/
├── middleware/
│   ├── client-ip.test.ts
│   ├── cookie.test.ts
│   └── rate-limit.test.ts
└── routes/
    ├── grades.test.ts
    └── grades-events.test.ts
tests/unit/_helpers/
└── fake-store.ts                NEW — extract the in-memory GradeStore from Plan 5 test files

tests/integration/server/
├── rate-limit.test.ts           NEW — real Redis + Postgres bucket lifecycle
└── grades-events-live.test.ts   NEW — full lifecycle with real HTTP + in-process worker
```

### Dependency injection

```ts
// src/server/deps.ts
export interface ServerDeps {
  store: GradeStore
  redis: Redis                           // main connection — pub, not sub
  redisFactory: () => Redis              // factory for per-SSE-connection subscribers
  pingDb: () => Promise<boolean>
  pingRedis: () => Promise<boolean>
  env: { NODE_ENV: 'development' | 'test' | 'production' }  // just what the app needs
}
```

`server.ts` (entrypoint) builds `ServerDeps` from the env singleton + a single Redis + PostgresStore. `app.ts` receives `ServerDeps` and returns a `Hono` instance. Tests inject fakes.

### Invariants

- `src/server/**` imports from `src/store/`, `src/queue/`, `src/config/`. Does NOT import from `src/worker/`, `src/scraper/` (they run in the worker process), or any route file from another route file.
- `/healthz` mounts on the root app *before* cookie/ip middleware, so Kubernetes-style liveness probes don't produce DB writes (upsertCookie).
- Rate-limit middleware mounts ONLY on `POST /grades`. `GET /grades/:id` and `GET /grades/:id/events` are unlimited — users should be able to reload the live page freely.
- SSE connections get their own Redis connection (via `redisFactory`). ioredis locks a connection into pub/sub mode on `.subscribe()`, so the main `deps.redis` can't be reused.

## 4. Request lifecycles

### POST /grades

1. `clientIp` middleware → `c.var.clientIp`.
2. `cookie` middleware → `c.var.cookie`, issuing a new UUID if none present. `store.upsertCookie(newCookie)` runs only on issuance.
3. `rateLimit` middleware → looks up `store.getCookie(cookie)` to pick limit (3 anon / 13 if `userId` present); runs the Redis sorted-set `bucket:ip:<ip>+cookie:<cookie>` check. 429 if over.
4. Handler → `@hono/zod-validator` parses `{ url: string }` (scheme check to `http:`/`https:`). Creates `grades` row with `tier: 'free'` and `status: 'queued'`. Enqueues `run-grade` job. Returns `202 { gradeId }`.

Race window between ZCARD and ZADD can admit slight overage under burst. On production checklist.

### GET /grades/:id

1. `clientIp` + `cookie` middleware (no rate limit).
2. Handler → validates `:id` is a UUID syntactically. `store.getGrade(id)` → 404 if missing, 403 if `grade.cookie !== c.var.cookie`. Returns the grade row (id, url, domain, tier, status, overall, letter, scores, timestamps).

Does NOT return probes or scrape. Clients fetch those via the events stream, which hydrates past state.

### GET /grades/:id/events (SSE)

1. Same middleware stack (no rate limit).
2. Auth check: 404 if missing, 403 if cookie mismatch.
3. Hydrate from DB:
   - If `status === 'done'` or `'failed'`: emit a single synthesized `done`/`failed` event. Close stream. No Redis subscription.
   - Otherwise emit `running`, then `scraped` if `scrapes` row exists, then one `probe.completed` per `probes` row (chronological order). Synthesized events use fields from each probe row: `score`, `metadata.label`, `metadata.latencyMs`, `metadata.error`. No `category.completed` events synthesized (aggregate not persisted; frontend derives it).
4. Live events: create dedicated subscriber via `deps.redisFactory()`, iterate `subscribeToGrade(subscriber, id, clientAbortSignal)`, forward each to stream. Loop terminates on `done`/`failed` (iterator completes) or on client disconnect (`c.req.raw.signal.aborted`).
5. Finally block: `subscriber.quit()`.

## 5. Middleware reference

### `client-ip.ts`
- Reads `x-forwarded-for` header, splits on comma, trims, takes index 0.
- Falls back to `c.env.incoming.socket.remoteAddress` (provided by `@hono/node-server`).
- Final fallback: `'0.0.0.0'`.
- Sets `c.var.clientIp`.

### `cookie.ts`
- Reads `ggcookie` cookie via `hono/cookie` `getCookie`.
- If absent: generates `crypto.randomUUID()`, calls `store.upsertCookie(cookie)`, sets cookie via `setCookie` with `{ httpOnly: true, sameSite: 'Lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: 31_536_000 }`.
- Sets `c.var.cookie`.
- Takes `store` and `isProduction` (or reads env lazily) — exact signature per implementer preference, both work.

### `rate-limit.ts`
- Exports `checkRateLimit(redis, store, ip, cookie, now?) → { allowed, limit, used, retryAfter }` as a pure-ish function for testing.
- Exports `rateLimitMiddleware(redis, store)` for route mounting.
- Algorithm: `store.getCookie(cookie)` → determines limit (3 / 13). `key = 'bucket:ip:' + ip + '+cookie:' + cookie`. `ZREMRANGEBYSCORE key -inf (now-86400000)`. `ZCARD key`. If used ≥ limit: `ZRANGE key 0 0 WITHSCORES` → `retryAfter = ceil((oldestScore + 86400000 - now) / 1000)`; return 429 payload. Else: `ZADD key now '<now>-<uuid>'` + `EXPIRE key 86400` + allow.
- 429 body: `{ paywall: 'email', limit, used, retryAfter }`.

## 6. Route reference

### `grades.ts`
- **Module export:** `gradesRouter(deps): Hono<{ Variables: { cookie, clientIp } }>` — takes `ServerDeps`, returns a Hono sub-app.
- **`POST /`:** `zValidator('json', CreateGradeBody)` validates `{ url: string }` with `http:`/`https:` scheme constraint. Derives domain from URL. `store.createGrade({ url, domain, tier: 'free', cookie, userId: null, status: 'queued' })`. `enqueueGrade({ gradeId, tier: 'free' }, deps.redis)`. `return c.json({ gradeId }, 202)`.
- **`GET /:id`:** UUID syntax check → 400. `store.getGrade(id)` → 404 if null. Cookie-ownership check → 403. Return grade row as JSON (id, url, domain, tier, status, overall, letter, scores, createdAt, updatedAt).

### `grades-events.ts`
- **Module export:** `gradesEventsRouter(deps): Hono<...>`.
- **`GET /:id/events`:** UUID check → 400, get grade → 404/403, then:
  - `return streamSSE(c, async (stream) => { ... })` from `hono/streaming`.
  - Hydrate: short-circuit for terminal status; otherwise synthesize `running` + `scraped` + per-probe events.
  - Subscribe via `deps.redisFactory()` + `subscribeToGrade`. Pipe each event to `stream.writeSSE({ data: JSON.stringify(event) })`.
  - Cleanup: `subscriber.quit()` in a `finally` block.

## 7. Store additions

```ts
// src/store/types.ts — added to GradeStore interface
getCookie(cookie: string): Promise<Cookie | null>
```

```ts
// src/store/postgres.ts — implementation
async getCookie(cookie: string): Promise<Cookie | null> {
  const [row] = await this.db.select().from(schema.cookies).where(eq(schema.cookies.cookie, cookie)).limit(1)
  return row ?? null
}
```

The `Cookie` type already exists from Plan 1's schema (`{ cookie: string, userId: string | null, createdAt: Date }`).

## 8. App composition (`src/server/app.ts`)

Modified `buildApp` wires everything:

1. Mount `GET /healthz` first, no middleware — dependency-free probe.
2. In development, mount `cors({ origin: 'http://localhost:5173', credentials: true })` globally (after healthz so curl-style health checks don't need CORS).
3. Build a `/grades` sub-router with `clientIp()` + `cookieMiddleware(deps.store)` applied to all its paths.
4. Apply `rateLimitMiddleware(deps.redis, deps.store)` scoped to `POST /`.
5. `gradeScope.route('/', gradesRouter(deps))`.
6. `gradeScope.route('/', gradesEventsRouter(deps))`.
7. `app.route('/grades', gradeScope)`.

## 9. Public surface additions

No changes to `src/index.ts`. The HTTP server isn't a library — it's an entrypoint. Tests import `buildApp` directly from `./app.ts`.

## 10. Testing

### Unit tests (~28, all using `app.fetch` + in-memory fakes)

- `tests/unit/_helpers/fake-store.ts` — extract the `makeFakeStore` from Plan 5's `categories.test.ts` + `run-grade.test.ts`. Shared across Plan 5 and Plan 6a unit tests. Adds `getCookie` method (returns the current cookies map's entry).
- `tests/unit/server/middleware/client-ip.test.ts` (~4 tests)
- `tests/unit/server/middleware/cookie.test.ts` (~4 tests)
- `tests/unit/server/middleware/rate-limit.test.ts` (~8 tests). Uses a stub Redis with sorted-set methods (`zadd`, `zcard`, `zremrangebyscore`, `zrange`, `expire`) backed by an in-memory Map. Inject `now` for deterministic time tests.
- `tests/unit/server/routes/grades.test.ts` (~8 tests)
- `tests/unit/server/routes/grades-events.test.ts` (~4 tests, covers only the early-exit paths: not-found, wrong-cookie, done, failed. Live streaming is tested in integration.)

### Integration tests (~6, testcontainers)

- `tests/integration/server/rate-limit.test.ts` (~3 tests). Real Redis sorted-set + Postgres for cookie lookup. Verify: 3 passes + 4th blocks (anon); after promoting cookie's userId, 13 passes + 14th blocks; bucket ages off correctly.
- `tests/integration/server/grades-events-live.test.ts` (~3 tests). Spawns Hono via `@hono/node-server` on an ephemeral port, starts `registerRunGradeWorker` in-process with `MockProvider`. POST /grades → open SSE → verify event sequence → close. Reconnect test: close mid-stream, reopen, verify hydration replays past events + continues with live ones.

No real LLM calls. No real Playwright.

## 11. Out of scope for Plan 6a

- **React frontend** — Plan 6b.
- **Auth / magic link** — Plan 7. (The `userId` lookup in rate-limit is ready; no verify route exists yet.)
- **Stripe checkout / webhook** — Plan 8.
- **Paid-tier promotion** (`generate-report` job that runs extra providers) — Plan 8.
- **Report routes (`GET /report/:id`, `.pdf`)** — Plan 9.
- **`/my/grades`** — Plan 7 (requires auth session).
- **Rate-limit atomicity (Lua script)** — production checklist.
- **Full SSRF defense (DNS-pinned fetcher)** — production checklist.
- **Cookie HMAC signing** — production checklist.
- **Trusted-proxy allow-list for XFF** — production checklist.
- **SSE `Last-Event-ID` replay** — deliberately not supported; every reconnect hydrates from DB.
- **CORS in production** — same-origin only; frontend is served from the Hono process.

## 12. Relationship to master spec §10

The master spec §10 lists 10 routes total. Plan 6a ships three of them:

- `POST /grades` ✓
- `GET /grades/:id` ✓
- `GET /grades/:id/events` ✓

The rest:
- `POST /auth/magic`, `GET /auth/verify` → Plan 7.
- `POST /billing/checkout`, `POST /billing/webhook` → Plan 8.
- `GET /report/:id`, `GET /report/:id.pdf` → Plan 9.
- `GET /my/grades` → Plan 7.

Master spec's §4.3 steps 1–4 are this plan's concern; step 5 is the worker (Plan 5, shipped); step 6 is Plan 6b.

After this spec is approved, master spec §10 should be amended with a short "Plan 6a interpretation calls" anchor pointing at this sub-spec — same precedent as Plans 3/4/5.
