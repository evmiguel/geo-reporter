# GEO Reporter — Plan 10 (Deploy to Railway) design

> Sub-spec for Plan 10. Brainstormed 2026-04-19. Plan 10 takes the feature-complete app (Plans 1–9 + credits pack + subsequent fixes) and puts it on a public URL (`https://geo.erikamiguel.com`) with real email, live Stripe, and the soft-launch security gates from `docs/production-checklist.md`. Hardening items that don't block soft launch stay in the checklist for Plan 11.

## 1. Scope

The ship bar for Plan 10 is **soft launch** (per brainstorm Q): a public URL that a small, unmarketed audience can reach and pay on, without catastrophic security holes. The bar is NOT hardened-for-HN-traffic — OTel tracing, atomic rate limits, per-provider backpressure, auto-refund on failure, and admin dashboards stay deferred.

**In scope**

- Railway project with four services (`web`, `worker`, Postgres, Redis).
- Multi-stage `Dockerfile` at repo root; both services share the image.
- `src/mail/resend-mailer.ts` implementing the existing `Mailer` interface. Factory in `src/server/server.ts` picks `RealMailer` when `RESEND_API_KEY` is set, else `ConsoleMailer`.
- `src/server/middleware/request-log.ts` — Hono logger with `?t=` / `?token=` query-param redaction. Wired at the top of `buildApp()`.
- SSRF pre-flight DNS check + IP-pinned `fetch`/Playwright in `src/scraper/fetch.ts` and `src/scraper/render.ts`.
- Trusted-proxy allow-list (`TRUSTED_PROXIES` env) for `X-Forwarded-For` parsing in `src/server/middleware/client-ip.ts`.
- Per-cookie rate limit on `POST /billing/checkout` (10/hour).
- Secrets-in-logs audit pass: truncate provider-error bodies to 200 chars.
- `worker.close(true)` with 30s drain-timeout on SIGTERM.
- Deploy runbook at `docs/deploy-runbook.md`.
- Post-deploy smoke test script at `scripts/smoke-prod.ts`.

**Out of scope (Plan 11+ / post-launch)**

- Atomic Lua-scripted rate limits for grades and `/auth/magic`.
- CSRF tokens on mutation routes.
- OTel tracing + structured metrics export.
- Per-provider rate-limit queues / backpressure.
- Auto-refund on `generate-report` failure.
- Admin dashboard (payment reconciliation, credit grants, stuck-pending PDF requeue).
- PDF storage migration to S3/R2.
- Frontend CDN split (Cloudflare Pages / Vercel).
- Cost tracking in dollars.
- Paid-tier 4-provider accuracy rework.
- Cancel / abort a running grade.
- Accuracy prompt tuning ("bias toward timeless facts", "I-don't-know" → null).
- Real-provider smoke test in CI.
- Transactional `reports` + `report_pdfs` init (user-invisible; flagged in checklist).

## 2. Decisions locked in on 2026-04-19

| # | Decision | Choice | Why |
|---|---|---|---|
| P10-1 | Ship bar | Soft launch — public URL, unmarketed, responsible security floor | #1 is friends-and-family (too loose), #3 is hardened launch (premature). #2 is the smallest bar that's honest with real money + real data. |
| P10-2 | Platform | Railway | Spec decision from master spec; add-on Postgres + Redis + auto-TLS align well. |
| P10-3 | Domain | `geo.erikamiguel.com` subdomain on GoDaddy DNS | User owns the apex domain already; subdomain isolates app from personal email routing. |
| P10-4 | Email provider | Resend, sending from `send.geo.erikamiguel.com` | Developer-friendly API, generous free tier, React Email compat. Subdomain sender isolates DKIM/SPF from any Google Workspace records on the apex. |
| P10-5 | Frontend topology | Single Hono process serving SPA via `serveStatic` | One service to deploy; sufficient for soft-launch traffic. CDN split stays on the checklist. |
| P10-6 | Build strategy | Multi-stage `Dockerfile` at repo root | Explicit control over Node version, pnpm install layers, and Playwright sysdeps. Nixpacks would require `nixpacks.toml` for Chromium anyway. |
| P10-7 | Service topology | Four services: `web`, `worker`, Postgres, Redis | Web and worker have different scaling characteristics (I/O vs CPU). Keeping them separate lets Railway scale each independently. |
| P10-8 | DB migrations | Pre-deploy hook on `web` service: `pnpm db:migrate` | Single-instance-safe (runs before new version goes live). Alternative patterns (app-start migration, manual) have concurrency or discipline hazards. |
| P10-9 | Request logging | `hono/logger` with custom URL serializer + `?t=` redaction | No external aggregator needed for MVP; Railway's log viewer pipes from stdout. Unblocks the Plan 9 redaction deferral. |
| P10-10 | SSRF defense | DNS-lookup-time check + IP-pinned outgoing request | Layered defense. Can't rely on Railway egress rules alone — some probes hit localhost intentionally in dev, which means the lookup-based check is the one that applies to the request path. |
| P10-11 | Trusted-proxy | `TRUSTED_PROXIES` env (CIDR list), enforced only in `NODE_ENV=production` | Dev keeps the current unconditional XFF trust for ergonomic testing. |
| P10-12 | `/billing/checkout` rate limit | 10 per cookie per hour | Matches `peekBucket` pattern already in the codebase. Prevents pending-row spam without affecting legitimate paths (user typically hits this ~twice per report purchase). |
| P10-13 | Secrets-in-logs | Truncate `ProviderError.message` body to 200 chars | Provider 4xx bodies sometimes echo request headers; truncation covers the accidental-echo case without losing useful diagnostic info. |
| P10-14 | Graceful shutdown | `worker.close(true)` + 30s await | Railway sends SIGTERM 30s before SIGKILL; matches that window exactly. |
| P10-15 | Stripe live-mode | Env-driven, no code changes | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_ID` / `STRIPE_CREDITS_PRICE_ID` point at live-mode values in Railway env. |
| P10-16 | Post-deploy smoke | `scripts/smoke-prod.ts` — healthz + free-tier grade; no Stripe | Stripe live-mode doesn't accept test cards; a paid-flow smoke is manual. Automated smoke covers the critical path. |
| P10-17 | Rollback | Railway's deploy history | Forward-only migrations in Plan 10; rollback doesn't need a data migration. |

## 3. Architecture

```
Dockerfile                              NEW — multi-stage build (deps → build → runtime)
.dockerignore                           NEW — exclude .worktrees, tests, docs, .env
docs/deploy-runbook.md                  NEW — one-time setup + deploy/verify/rollback steps

src/mail/
└── resend-mailer.ts                    NEW — implements Mailer via `resend` npm pkg

src/server/
├── server.ts                           MODIFY — factory picks RealMailer vs ConsoleMailer by env
├── app.ts                              MODIFY — mount request-log middleware first
└── middleware/
    ├── request-log.ts                  NEW — hono/logger wrapper + URL redaction
    └── client-ip.ts                    MODIFY — TRUSTED_PROXIES enforcement in production

src/server/routes/
└── billing.ts                          MODIFY — add per-cookie bucket on /checkout

src/scraper/
├── fetch.ts                            MODIFY — pre-flight DNS check + IP-pinned undici agent
└── render.ts                           MODIFY — same SSRF check before page.goto

src/llm/providers/
└── errors.ts                           MODIFY — truncate stored message body to 200 chars

src/config/env.ts                       MODIFY — accept RESEND_API_KEY, MAIL_FROM, TRUSTED_PROXIES, STRIPE_CREDITS_PRICE_ID (already present)

src/worker/worker.ts                    MODIFY — worker.close(true) + 30s await in SIGTERM

scripts/
└── smoke-prod.ts                       NEW — healthz + free-tier grade end-to-end

tests/unit/
├── mail/resend-mailer.test.ts          NEW — contract test against Mailer interface (fetch stub)
├── server/middleware/request-log.test.ts   NEW — verify `?t=` redaction
├── server/middleware/client-ip-trusted.test.ts   NEW — XFF honored only from allow-listed peer
├── server/routes/billing-checkout-rate-limit.test.ts   NEW
├── scraper/ssrf.test.ts                NEW — private IP rejection + metadata-IP rejection
└── worker/shutdown.test.ts             NEW — drain-flag behavior (mocked Worker.close)

tests/integration/
└── deploy-smoke.test.ts                NEW — same script logic, end-to-end against testcontainers
```

### 3.1 Dockerfile shape

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
COPY --from=deps /app/node_modules /app/node_modules
COPY . .
RUN pnpm build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Playwright sysdeps. Keep this list in sync with README / CLAUDE.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnspr4 libnss3 libasound2t64 libgtk-3-0 libgbm1 \
    ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
# Install just the runtime deps (prod-only subset) and bake Chromium into the image.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate \
 && pnpm install --prod --frozen-lockfile \
 && pnpm exec playwright install chromium --with-deps
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
# drizzle-kit lives in dev-deps but `pnpm db:migrate` needs it at deploy time.
# Pre-deploy hook runs: `pnpm --package=drizzle-kit@0.33 dlx drizzle-kit migrate`
# using a lightweight one-shot, so we don't bloat the runtime image.
CMD ["node", "dist/server.js"]
```

Two services use the same image; Railway's per-service start-command overrides `CMD`:
- `web`: `node dist/server.js`
- `worker`: `node dist/worker.js`

Pre-deploy (on `web` service): `pnpm --package=drizzle-kit@0.33 dlx drizzle-kit migrate --config=drizzle.config.ts`. Runs once per deploy before the new revision goes live.

### 3.2 Service env matrix

| Var | Scope | Who reads it |
|---|---|---|
| `DATABASE_URL` | Auto (Postgres add-on) | web + worker |
| `REDIS_URL` | Auto (Redis add-on) | web + worker |
| `NODE_ENV=production` | Shared | web + worker |
| `PORT` | Auto (Railway) | web |
| `PUBLIC_BASE_URL=https://geo.erikamiguel.com` | Shared | web (Stripe success/cancel URLs + magic-link URLs) |
| `COOKIE_HMAC_KEY` | Shared (32-char random) | web |
| `TRUSTED_PROXIES` (Railway edge CIDRs) | Shared | web |
| `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` + `GEMINI_API_KEY` + `PERPLEXITY_API_KEY` | Shared | worker (and web if any LLM call is added to the request path later) |
| `OPENROUTER_API_KEY` | Shared (optional) | worker |
| `RESEND_API_KEY` + `MAIL_FROM=noreply@send.geo.erikamiguel.com` | Shared | web |
| `STRIPE_SECRET_KEY=sk_live_...` | Shared | web |
| `STRIPE_WEBHOOK_SECRET=whsec_live_...` | Shared | web |
| `STRIPE_PRICE_ID=price_...` (live $19 report) | Shared | web |
| `STRIPE_CREDITS_PRICE_ID=price_...` (live $29 credits) | Shared | web |

## 4. Production stub replacements

### 4.1 `RealMailer` via Resend

```ts
// src/mail/resend-mailer.ts
import { Resend } from 'resend'
import type { Mailer } from './types.ts'

export class ResendMailer implements Mailer {
  private readonly client: Resend
  private readonly from: string

  constructor(opts: { apiKey: string; from: string }) {
    this.client = new Resend(opts.apiKey)
    this.from = opts.from
  }

  async sendMagicLink(input: { email: string; url: string; expiresAt: Date }): Promise<void> {
    const expiresIn = formatExpiry(input.expiresAt)
    const { error } = await this.client.emails.send({
      from: this.from,
      to: input.email,
      subject: 'Sign in to GEO Reporter',
      text: `Click to sign in: ${input.url}\n\nThis link expires ${expiresIn}.`,
      html: renderMagicHtml(input.url, expiresIn),
    })
    if (error) throw new MailerError(`resend: ${error.message}`)
  }
}
```

Factory in `src/server/server.ts`:

```ts
const mailer: Mailer = env.RESEND_API_KEY && env.MAIL_FROM
  ? new ResendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM })
  : new ConsoleMailer()
```

Contract test uses a stubbed `Resend` class (injected fetch) to verify the wire shape.

### 4.2 Stripe live-mode

No code change. Runbook §5.4 covers dashboard setup + env.

### 4.3 Request logger + token redaction

```ts
// src/server/middleware/request-log.ts
import { logger } from 'hono/logger'
import type { MiddlewareHandler } from 'hono'

export function redactUrl(url: string): string {
  return url.replace(/([?&])(t|token)=[^&]*/g, '$1$2=REDACTED')
}

export function requestLog(): MiddlewareHandler {
  // Custom print: default hono/logger prints the raw URL; we swap in a redacted one.
  return logger((method, status, rawUrl, ms) => {
    console.log(JSON.stringify({
      msg: 'http', method, status, url: redactUrl(rawUrl), ms,
    }))
  })
}
```

Wired at the top of `buildApp()` before any route mount. Unit test covers `redactUrl`: `?t=secret` → `?t=REDACTED`, `?token=secret&foo=bar` → `?token=REDACTED&foo=bar`, `?foo=bar` → unchanged.

## 5. Security gates

### 5.1 SSRF defense (`src/scraper/fetch.ts`, `src/scraper/render.ts`)

```ts
// src/scraper/ssrf.ts (new helper used by both)
import { Agent } from 'undici'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'

const PRIVATE_CIDRS = [
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  '127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8',
  '100.64.0.0/10',   // CGNAT
  '224.0.0.0/4',     // multicast
]
const PRIVATE_V6 = ['::1/128', 'fe80::/10', 'fc00::/7', 'ff00::/8']

export async function resolveSafeHost(host: string): Promise<LookupAddress> {
  const addrs = await lookup(host, { all: true })
  for (const a of addrs) {
    if (isPrivate(a.address)) throw new SSRFBlockedError(host, a.address)
  }
  return addrs[0]!   // pin the first safe address
}

export function makeSSRFSafeAgent(host: string, pinnedAddress: string): Agent {
  // Custom Agent that rewrites the socket connect target to the pinned IP,
  // so DNS rebinding can't swap it mid-request.
  return new Agent({ connect: { lookup: (_, __, cb) => cb(null, pinnedAddress, 4) } })
}
```

`fetchHtml(url)` calls `resolveSafeHost` first, then uses `fetch(url, { dispatcher: safeAgent })`. `scraper/render.ts` calls `resolveSafeHost` before `page.goto()`; Playwright's internal DNS doesn't have the same rebinding attack surface in the 60s scrape window, so the lookup check alone is sufficient there.

Local dev bypass: `NODE_ENV !== 'production'` skips the check so `http://localhost:*` URLs still work for local testing.

Test matrix: private IPs (10.x, 172.16.x, 192.168.x, 127.0.0.1), IPv6 loopback, link-local (169.254.169.254), CGNAT (100.64.x) — all rejected. Public IP (8.8.8.8) — allowed.

### 5.2 Trusted-proxy XFF

```ts
// src/server/middleware/client-ip.ts (modified)
function trustedPeer(peer: string, cidrs: string[]): boolean { /* ... */ }

export function clientIp(opts: { trustedProxies?: string[]; isProduction: boolean }): MiddlewareHandler {
  return async (c, next) => {
    const peer = c.req.header('x-real-ip') ?? c.env?.server?.remoteAddress ?? ''
    const xff = c.req.header('x-forwarded-for')
    const honorXff =
      xff !== undefined
      && (!opts.isProduction || trustedPeer(peer, opts.trustedProxies ?? []))
    const ip = honorXff ? xff.split(',')[0]!.trim() : peer
    c.set('clientIp', ip)
    await next()
  }
}
```

Wired from `buildApp(deps)`. `TRUSTED_PROXIES` env parsed into CIDR list at server startup. Empty list in production + XFF present = ignore XFF (use socket peer), which is the safe default.

### 5.3 `/billing/checkout` rate limit

```ts
// src/server/routes/billing.ts — inside the /checkout handler, before Stripe session creation
const cfg = { key: `bucket:checkout:${c.var.cookie}`, limit: 10, windowMs: 3_600_000 }
const peek = await peekBucket(deps.redis, cfg, Date.now())
if (!peek.allowed) return c.json({
  error: 'rate_limited', paywall: 'checkout_throttled' as const,
  retryAfter: peek.retryAfter,
}, 429)
await addToBucket(deps.redis, cfg, Date.now())
```

Frontend (`src/web/lib/api.ts`) already handles generic 429 gracefully; adding a new error kind `'rate_limited'` is a one-line addition to the `CheckoutResult` union.

### 5.4 Secrets-in-logs audit

Single surgical change: `ProviderError.message` currently concatenates the full response body (`` `anthropic ${status}: ${text}` ``). Change the provider error constructors to truncate `text` to 200 chars with an ellipsis. Prevents accidental API-key echo (some providers echo `x-api-key` in 400 bodies when malformed).

Manual audit pass: grep for `console.log|logger\.(info|warn|error)` in `src/server/` and `src/worker/` + `src/queue/workers/`. Confirm no `env.*_API_KEY`, `env.COOKIE_HMAC_KEY`, `env.DATABASE_URL` leaks.

### 5.5 Graceful worker shutdown

```ts
// src/worker/worker.ts — shutdown handler
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'worker shutting down', signal }))
  const drainTimeout = setTimeout(() => {
    console.log(JSON.stringify({ msg: 'drain timeout, forcing close' }))
    process.exit(1)
  }, 30_000)
  await Promise.all(workers.map((w) => w.close(true)))   // true = wait for active jobs
  clearTimeout(drainTimeout)
  await connection.quit()
  await closeDb()
  await shutdownBrowserPool()
  process.exit(0)
}
```

## 6. Deploy runbook (copied into `docs/deploy-runbook.md`)

### 6.1 One-time account setups (parallel with code work)

- **Resend account** — sign up, add `send.geo.erikamiguel.com` as sending domain. Resend produces 3 DNS records (SPF TXT, DKIM CNAME/TXT, MAIL FROM). Paste into GoDaddy DNS. DNS propagation up to 24h; start this early.
- **Railway account** — create empty project. No services yet.
- **Stripe live-mode** — flip dashboard toggle; complete any outstanding account verification prompts. Don't create prices or webhook yet.

### 6.2 Railway service creation

1. Add Postgres add-on. Copy `DATABASE_URL` into shared env.
2. Add Redis add-on. Copy `REDIS_URL` into shared env.
3. Create `web` service pointing at this repo. Start command: `node dist/server.js`. Pre-deploy: `pnpm --package=drizzle-kit@0.33 dlx drizzle-kit migrate`.
4. Create `worker` service pointing at the same repo. Start command: `node dist/worker.js`.
5. Both services use the `Dockerfile` at repo root. Configure in Railway service settings.

### 6.3 Shared env vars (paste at project level)

See §3.2 matrix. Anything marked "Shared" goes in the Railway project-level env; add-on URLs are auto. Don't commit `TRUSTED_PROXIES` — fetch Railway's edge IPs from their docs at deploy time (documented in the runbook).

### 6.4 Custom domain

1. Railway `web` service → Settings → Domains → "Add custom domain" → `geo.erikamiguel.com`. Railway shows a CNAME target (e.g. `<project>.up.railway.app`).
2. GoDaddy DNS → add CNAME: `geo` → `<project>.up.railway.app`.
3. Wait for Railway to provision TLS (Let's Encrypt) — usually 2-5 min after DNS resolves.

### 6.5 Stripe live-mode config

1. Stripe dashboard (live mode toggle on) → Products → create two products:
   - "GEO Report" — $19 one-time. Copy the `price_...` ID → `STRIPE_PRICE_ID`.
   - "Credits Pack" — $29 one-time. Copy the `price_...` ID → `STRIPE_CREDITS_PRICE_ID`.
2. Developers → Webhooks → Add endpoint → `https://geo.erikamiguel.com/billing/webhook`. Subscribe to `checkout.session.completed`. Reveal signing secret → `STRIPE_WEBHOOK_SECRET`.
3. Keys → Secret → copy the live secret key (`sk_live_...`) → `STRIPE_SECRET_KEY`.

### 6.6 Post-deploy smoke

```bash
# From a local shell with RAILWAY_PUBLIC_BASE_URL set:
pnpm tsx scripts/smoke-prod.ts
```

Output (success):
```
✓ GET /healthz → 200 { ok: true, db: true, redis: true }
✓ POST /grades { url: "https://example.com" } → 202 { gradeId: "..." }
✓ SSE /grades/:id/events → done in 43s
✓ GET /grades/:id → { overall: 72, letter: "C", ... }
smoke-prod: all checks passed
```

Manual end-to-end (not scripted — live mode, no test cards):
1. Browser to `https://geo.erikamiguel.com`.
2. Submit a URL, watch live grade.
3. Verify email with magic link (check real inbox).
4. Buy credits or a $19 report with a real card (cancel before actually charging, or use a low-fee card and refund afterwards).
5. Confirm report renders and PDF downloads.

### 6.7 Rollback

Railway service → Deployments → click prior revision → "Redeploy". DB schema in Plan 10 is forward-only (no column drops, no destructive changes), so no data migration needed to roll back the app. If a future plan ships a breaking schema change, this runbook gets a "down-migration" step.

## 7. Testing strategy

### 7.1 Unit (new)

- `resend-mailer.test.ts` — contract: stub `Resend.emails.send`, assert body shape + error propagation.
- `request-log.test.ts` — `redactUrl` truth table: `?t=abc`, `?token=abc`, `?foo=bar&t=abc&baz=qux`, `?foo=bar` (unchanged), empty string.
- `client-ip-trusted.test.ts` — XFF honored only when peer in allow-list; production default (empty list) ignores XFF.
- `billing-checkout-rate-limit.test.ts` — 10 attempts pass, 11th returns 429 with `paywall: 'checkout_throttled'`.
- `ssrf.test.ts` — private IPv4/IPv6 rejected; cloud metadata (169.254.169.254) rejected; 8.8.8.8 allowed; bypassed in dev env.
- `shutdown.test.ts` — `worker.close(true)` called; 30s timeout triggers force-exit (stubbed).

### 7.2 Integration

- `deploy-smoke.test.ts` — testcontainers version of `smoke-prod.ts`: real Postgres + Redis, MockProvider, issues anon grade, polls until done, asserts scorecard shape. Covers the same code paths as the prod smoke.

### 7.3 Not included

- Real-provider smoke test in CI (checklist item, deferred).
- Load test against the deployed service (would need rate limits tuned first).

## 8. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Resend domain verification takes >24h | Runbook §6.1 starts this in parallel with code work; MVP can fall back to `ConsoleMailer` on Railway temporarily (magic-link URL logged, grab via Railway log viewer) while DNS propagates. |
| Railway cold-start latency on the `worker` | Worker runs continuously (BullMQ long-poll), no real cold starts. `web` cold-starts are ~300ms with a baked Docker image. |
| SSRF defense breaks `http://localhost` scraping during testing | Dev bypass (`NODE_ENV !== 'production'`). Production never scrapes localhost, by definition. |
| Live Stripe fees on testing | Manual end-to-end smoke uses a real card; refund immediately via the Stripe dashboard. |
| Migration fails mid-deploy | Pre-deploy hook fails the deploy; Railway keeps the prior version live. No partial migration state reaches users. |
| Railway edge CIDRs change | Plan 11 can move to a cleaner trusted-proxy approach (e.g. mTLS between Cloudflare and Railway) if it becomes an issue. |

## 9. Deferred / production-checklist follow-ups

Items NOT in Plan 10 that stay on `docs/production-checklist.md`:

- Atomic Lua rate-limit script (bounded overage acceptable at soft launch).
- CSRF tokens on mutation routes (logout-only CSRF is the only surface; bounded).
- OTel tracing + structured metrics export.
- Per-provider rate-limit queues / backpressure.
- Auto-refund on `generate-report` failure (manual for soft launch).
- Admin dashboard (direct SQL for soft launch).
- PDF storage migration to S3/R2 (BYTEA fine at soft-launch volume).
- Accuracy prompt-tuning items (product iteration, not deploy).
- Frontend CDN split.

## 10. Success criteria

Plan 10 is done when:

1. `https://geo.erikamiguel.com` resolves and serves the app over TLS.
2. `GET /healthz` returns 200 + `{ ok: true, db: true, redis: true }`.
3. An anonymous user can grade a public URL and see the live scorecard.
4. A user can verify email via a magic link delivered to a real inbox.
5. A user can buy $19 or $29 credits via live Stripe with a real card.
6. A paid report renders as HTML at `/report/:id?t=...` and downloads as PDF.
7. `scripts/smoke-prod.ts` passes.
8. `pnpm test:integration` includes `deploy-smoke.test.ts` passing.
9. All new code is behind 80%+ test coverage on the critical paths (DNS check, token redaction, rate limit, mailer contract, graceful shutdown).
10. Runbook at `docs/deploy-runbook.md` is current enough that a second person (or future-you) could follow it end-to-end.
