# geo-reporter (v3)

A public, paywalled web app that grades websites on how well LLMs know them. Scrapes the site, runs LLM probes across six categories (Discoverability, Recognition, Accuracy, Coverage, Citation, SEO), and produces an HTML + PDF report with recommendations.

**Status:** pipeline + HTTP + React UI + magic-link auth + Stripe + credits-pack + report rendering shipped. The scoring pipeline runs, the Hono HTTP API is live, the React terminal-aesthetic frontend consumes it via SSE, a 3-tier rate limit is in place (anonymous 3/24h, email-verified 3/24h, credit-holder 10/24h), and paid reports render as a server-side HTML page plus a Playwright-generated PDF. Deploy is still ahead — see [Roadmap](#roadmap).

**You can grade a real website end-to-end today** in three ways:

1. [**Browser**](#grading-in-the-browser) (recommended) — `pnpm dev:web`, paste a URL at `http://localhost:5173`, watch the live scorecard fill in.
2. [**HTTP**](#grading-via-http-curl) — `curl`-testable. Same endpoints the React UI uses.
3. [**Dev CLI**](#grading-via-cli-smoke-test) — `pnpm enqueue-grade <url>`, skips rate limit + cookie plumbing.

All three require API keys for the four supported LLM providers.

For the full architecture and the 17 locked-in design decisions, see [`docs/superpowers/specs/2026-04-17-geo-reporter-design.md`](docs/superpowers/specs/2026-04-17-geo-reporter-design.md). For working conventions and footguns, see [`CLAUDE.md`](CLAUDE.md). For deferred items needed before shipping to real users, see [`docs/production-checklist.md`](docs/production-checklist.md).

## What runs today

| Surface | State |
| --- | --- |
| `scrape(url)` library (`src/scraper/`) | Works. Static fetch → Playwright fallback, extractors, discovery probes. |
| `evaluateSeo(scrape)` library (`src/seo/`) | Works. 10 deterministic signals → `{ score, signals }`. |
| `src/llm/` — 4 providers + MockProvider + prompts + judge + flows | Works. |
| `src/scoring/` — pure scorers + composite | Works. |
| `src/accuracy/` — generator + per-provider verifier + orchestrator | Works. |
| BullMQ `run-grade` worker (`pnpm dev:worker`) | Works. |
| **`GET /healthz`** on `pnpm dev:server` | Works. Returns `{ ok, db, redis }`. |
| **`POST /grades`** | Works. Validates URL, issues anonymous cookie, enforces 3/24h rate limit, enqueues job, returns `202 { gradeId }`. |
| **`GET /grades/:id`** | Works. Cookie-owner-only. Returns grade row JSON. |
| **`GET /grades/:id/events`** | Works. SSE stream — hydrates past state from DB on connect, then forwards Redis pub/sub events. |
| **React terminal UI** (`pnpm dev:web` on :5173) | Works. Landing, LiveGrade (SSE-driven), EmailGate, 404. |
| `pnpm enqueue-grade <url>` dev CLI | Works. Skips rate limit + cookie — for quick smoke tests. |
| `pnpm test` | 561 unit tests passing. |
| `pnpm test:integration` | 105 integration tests — testcontainers Postgres + Redis + MockProvider + real Chromium for PDF rendering. |
| `pnpm build` | Bundles `dist/server.js`, `dist/worker.js`, and `dist/web/` with tsup + vite. |
| **magic-link auth** (`POST /auth/magic`, `GET /auth/verify`, `POST /auth/logout`) | Works. Dev uses `ConsoleMailer` (magic link logged to stdout); verified email = identity + credit-balance portability. `/auth/magic` accepts an optional `next` param so the verify redirect can preserve the user's original page. |
| **`POST /billing/checkout` + `POST /billing/webhook`** | Works. Requires verified email. Defense-in-depth: if the user has credits, server redeems one instead of charging. Stripe checkout session creation + signed webhook → enqueues generate-report. |
| `POST /billing/buy-credits` + `POST /billing/redeem-credit` | Works. $29 Stripe Checkout for 10 credits; credits spend on `generate-report` without a round-trip to Stripe. |
| **`generate-report` worker** | Works. Delta probes (Gemini + Perplexity) + recompute + recommendation LLM + reports row + tier='paid' + chains a `render-pdf` job. |
| **`GET /report/:id?t=<token>`** | Works. Server-rendered HTML report — 7 sections (cover, scorecard, raw LLM responses, accuracy appendix, SEO findings, recommendations, methodology). LLM-authored prose rendered through markdown. Constant-time token compare; 404 (not 403) on any auth failure. |
| **`GET /report/:id.pdf?t=<token>`** | Works. Returns the PDF bytes when the `render-pdf` worker has populated `report_pdfs`; 202 `{status: pending}` while building, 503 on failure. Bytes stored in Postgres BYTEA. |
| **`GET /report/:id/status?t=<token>`** | Works. JSON `{html: 'ready', pdf: 'pending' \| 'ready' \| 'failed'}` — the frontend polls this while the PDF is rendering. |
| **`render-pdf` worker** | Works. Reuses the scraper's Playwright browser pool via a shared `withPage` primitive; `page.setContent(html)` + `page.pdf({format: 'Letter'})` → bytes into `report_pdfs`. |

## Prerequisites

- Node **20.12+** (needed for `--env-file-if-exists`; Node 22 LTS or 24 current both work)
- pnpm **9.x** (`corepack enable` then `corepack prepare pnpm@9.6.0 --activate`)
- Docker (for `docker compose` and for integration tests via testcontainers)
- **WSL2 / Linux only:** Playwright needs system libs once before Chromium will launch:
  ```
  sudo apt-get install -y libnspr4 libnss3 libasound2t64
  ```

## Setup

```bash
pnpm install
pnpm exec playwright install chromium

# start Postgres (:54320) and Redis (:63790)
docker compose up -d

# .env at the repo root — API keys are OPTIONAL in dev (tests use MockProvider),
# but REQUIRED to run an actual grade through the worker end-to-end.
cat > .env <<'EOF'
DATABASE_URL=postgres://geo:geo@localhost:54320/geo
REDIS_URL=redis://localhost:63790
NODE_ENV=development
PORT=7777

# Only needed if you want to run a real grade (via the dev CLI or dev worker).
# Tests do not need these — they use MockProvider.
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...
PERPLEXITY_API_KEY=pplx-...

# Optional — OpenRouter fallback.
# When set, transient errors (5xx / 429 / network) from direct LLM API calls
# (Claude / GPT / Gemini) auto-retry via OpenRouter with the same prompt.
# Perplexity is direct-only.
# OPENROUTER_API_KEY=
EOF

pnpm db:migrate
```

Quick sanity check: start the server and hit `/healthz`.

```bash
pnpm dev:server   # http://localhost:7777 — Hono HTTP + SSE
```

`curl http://localhost:7777/healthz` should return `{"ok":true,"db":true,"redis":true}`.

## Grading in the browser

**Three terminals:**

```bash
# Terminal 1 — Hono API on :7777
pnpm dev:server

# Terminal 2 — BullMQ worker (listens for run-grade jobs)
pnpm dev:worker

# Terminal 3 — Vite dev server on :5173 (HMR + proxy to :7777)
pnpm dev:web
```

**Open http://localhost:5173**, paste a URL, hit the "grade" button. You'll watch the live scorecard fill in over 30–90 seconds.

The Vite dev server proxies `/grades/*` and `/healthz` to Hono, so the browser sees a single origin. Cookies, SSE, and rate limiting behave identically to production.

### What you'll see

- **Landing `/`** — URL input; submit navigates to `/g/:id`.
- **LiveGrade `/g/:id`** — 6 category tiles fill in live via SSE; chronological probe log below. On `done`, a big letter grade replaces the status bar. The free scorecard is below a `Get the full report — $19` CTA that requires a verified email (inline magic-link form if not), kicks off Stripe Checkout, and on success watches SSE for `report.*` events. When the report is ready, a "View report" link points to the rendered HTML and a "Download PDF" link appears once the PDF worker finishes (the frontend polls `/report/:id/status` to know when).
- **Report `/report/:id?t=<token>`** — paid-only, server-rendered HTML. Cream/sans-serif aesthetic, 7 sections, markdown-rendered LLM prose. Open in any tab; CSP locks the page to inlined CSS only — no external resources.
- **Report PDF `/report/:id.pdf?t=<token>`** — same content piped through Playwright's `page.pdf({format:'Letter'})`. Built eagerly the moment `generate-report` finishes, so it's usually ready by the time a paying user clicks Download.
- **EmailGate `/email`** — shown on 429 (rate-limit hit). The form hits `/auth/magic`; verifying your email binds grades to an account for credit-balance portability (verified email is identity, not a quota bonus). To lift the cap, buy a credits pack ($29 for 10) — while `credits > 0` the quota is 10 per rolling 24h.

> **Heads up — there is no real email in dev.** `Mailer` uses `ConsoleMailer`, which **prints the magic-link URL to the terminal running `pnpm dev:server`** (look for a `======` banner). Copy that URL into your browser to verify. A real email provider lands in Plan 10 (needs domain + DKIM/SPF setup).
- **404 `*`** — any unknown route.

### Production build

```bash
pnpm build
node dist/server.js
```

One process serves API + SSE + the built React app on port 7777. No Vite dev server — Hono's `serveStatic` catch-all returns `index.html` for any unmatched GET so React Router handles deep links like `/g/:id` on page refresh.

## Grading via HTTP (curl)

Everything the React UI does is `curl`-testable. Useful for scripted smoke tests or when you want to see the raw SSE wire format.

**Terminals 1 and 2** — same as the browser flow above (`pnpm dev:server`, `pnpm dev:worker`).

**Terminal 3 — create a grade + watch the live stream:**

```bash
# 1. Create a grade. Save cookies so rate limit + ownership checks work.
RESP=$(curl -s -c /tmp/gg-cookies.txt -X POST http://localhost:7777/grades \
  -H 'content-type: application/json' \
  -d '{"url":"https://stripe.com"}')
echo "$RESP"
# → {"gradeId":"3f2b8e01-..."}

GRADE_ID=$(echo "$RESP" | jq -r .gradeId)

# 2. Stream live events. --no-buffer so curl doesn't hold lines.
curl -N --no-buffer -b /tmp/gg-cookies.txt \
  -H 'accept: text/event-stream' \
  http://localhost:7777/grades/$GRADE_ID/events
```

You'll see a stream like this (one SSE `data:` frame per event):
```
data: {"type":"running"}

data: {"type":"scraped","rendered":false,"textLength":5820}

data: {"type":"probe.started","category":"seo","provider":null,"label":"title"}

data: {"type":"probe.completed","category":"seo","provider":null,"label":"title","score":100,...}

...

data: {"type":"category.completed","category":"seo","score":90}

...

data: {"type":"done","overall":77,"letter":"C+","scores":{"discoverability":80,...}}
```

The stream closes when the grade finishes (`done` or `failed`). A free-tier grade typically writes 25 probe rows and takes 30–90 seconds.

**Reconnect after a drop**: just re-run the `curl /events` command. The endpoint rehydrates past state from the database, then resumes live events.

### Fetch the final scorecard

After the grade finishes:
```bash
curl -s -b /tmp/gg-cookies.txt http://localhost:7777/grades/$GRADE_ID | jq
# → { "id": "...", "url": "...", "status": "done", "overall": 77, "letter": "C+", "scores": {...} }
```

### Rate limit + 429

**Rate-limit tiers:**

- **Anonymous** (cookie only): 2 grades per 24h.
- **Email-verified:** 2 grades per 24h (email is identity + credit balance portability; no bonus).
- **Credit-holder:** 10 grades per 24h while `users.credits > 0`. Credits are $29 for 10, each redeems for a full paid report.

Hit the cap and the 3rd request returns:
```json
{
  "paywall": "email",
  "limit": 3,
  "used": 3,
  "retryAfter": 86397
}
```

## Grading via CLI (smoke test)

The dev CLI (`scripts/enqueue-grade.ts`) skips the HTTP layer — no rate limit, no cookie dance. Useful when iterating on the worker.

**Terminal 1** — start the worker: `pnpm dev:worker` (server is optional for this flow).

**Terminal 2 — enqueue a grade:**
```bash
pnpm enqueue-grade https://stripe.com            # free tier (2 providers: Claude + GPT)
pnpm enqueue-grade https://stripe.com --paid     # paid tier (4 providers)
```
Output:
```
enqueued grade 3f2b8e01-... (tier=free) for https://stripe.com
watch: redis-cli -p 63790 subscribe grade:3f2b8e01-...
```

**Terminal 3 — watch progress events via Redis pub/sub directly:**
```bash
# Subscribe to ALL grade channels BEFORE enqueueing — pub/sub doesn't replay.
redis-cli -p 63790 psubscribe "grade:*"
```

Same event stream as the HTTP SSE endpoint.

## Inspecting results in Postgres

```bash
# Connect to the dev Postgres
docker compose exec postgres psql -U geo geo

# Latest grade
SELECT id, url, status, overall, letter, scores FROM grades ORDER BY created_at DESC LIMIT 1;

# Probe rows for that grade
SELECT category, provider, score, metadata->>'label' AS label
FROM probes WHERE grade_id = '<gradeId>' ORDER BY created_at;

# Scrape payload
SELECT rendered, length(text) FROM scrapes WHERE grade_id = '<gradeId>';
```

### Tier matrix (from the spec)

| Tier | Probing providers | Total probe rows | Notes |
| --- | --- | --- | --- |
| `free` | Claude + GPT | 25 | 10 SEO signals + 4 recognition + 2 citation + 2 discoverability + 4 coverage + 3 accuracy (1 generator + 2 verify) |
| `paid` | Claude + GPT + Gemini + Perplexity | 39 | Same categories, 4 probers instead of 2 |

Judge / generator / verifier always use Claude regardless of tier (see `docs/superpowers/specs/2026-04-17-geo-reporter-plan-5-grade-pipeline-design.md` §2 P5-3). `POST /grades` always creates a free-tier job in MVP; paid-tier top-ups come via Plan 8's `generate-report` job after Stripe payment.

## When things go wrong

- **`Invalid environment: DATABASE_URL: Required`** → no `.env` file, or env vars not loaded. The dev scripts pass `--env-file-if-exists=.env` to Node so `.env` at the repo root is auto-loaded; check it's there.
- **Worker logs `buildProviders: ANTHROPIC_API_KEY is not set`** → missing key(s) in `.env`. The worker won't boot in production without all four; dev defers the check to provider use.
- **Seeing a lot of "gemini API error" or other provider failures mid-grade** → set `OPENROUTER_API_KEY` in `.env` and restart the worker. Transient failures (5xx / 429 / network) will auto-retry through OpenRouter, which proxies Claude / GPT / Gemini under one key. Perplexity is still direct-only.
- **Browser shows blank page at `http://localhost:5173`** → Vite dev server not running. `pnpm dev:web` must be running alongside `dev:server` + `dev:worker`.
- **Browser POST /grades fails with connection refused** → `pnpm dev:server` isn't running. Vite proxies `/grades/*` to port 7777; if nothing's there, the proxy 502s.
- **`POST /grades` returns 400** → URL validation rejected it. Must be `http://` or `https://`. Full SSRF defense (DNS pinning, private-IP blocking) is on the production checklist; for local dev, `http://localhost:...` URLs are allowed.
- **`GET /grades/:id/events` returns 403** → cookie mismatch. The SSE endpoint requires the same cookie that created the grade. If you used `-c cookies.txt` in the POST, pass `-b cookies.txt` to the SSE request. In the browser, cookies are automatic.
- **SSE stream hangs immediately then closes** → grade already finished (status `done` or `failed`). The endpoint synthesizes one terminal event and closes. Call `GET /grades/:id` for the final JSON.
- **Grade finalizes with `status='done'` but `scores.accuracy` is `null`** → expected. Happens when the scrape is sparse (< 500 chars) or the verifier can't judge from the scrape. Check `probes` rows with `category='accuracy' AND provider IS NULL` for the `reason` in metadata (`insufficient_scrape` | `all_null` | `all_failed`).
- **Grade finalizes with `status='failed'`** → look at the last `failed` event on the SSE stream (or Redis channel) for the error message. Typically a scrape producing < 100 chars of text (even after Playwright fallback).
- **Worker logs `ECONNREFUSED` during retry** → BullMQ retries 3× with exponential backoff. Each retry runs `clearGradeArtifacts(gradeId)` first for a clean slate; probe rows won't accumulate across attempts.
- **"Submitted my email but nothing happened"** → there's no real email in dev. Switch to the terminal running `pnpm dev:server` and look for the `======` banner from `ConsoleMailer` containing the magic-link URL. Copy it into your browser.
- **`POST /auth/magic` returns 429 `"Too many requests from this connection. Try again in 10m."`** → that's the per-IP 5/10m rate limit biting. Flush local Redis to reset: `redis-cli -p 63790 FLUSHALL`. Surgical version: `redis-cli -p 63790 --scan --pattern 'magic:ip:*' | xargs -r redis-cli -p 63790 DEL`.
- **`POST /auth/magic` returns 429 `"Please wait 60s before resending."`** → per-email 1/60s cooldown. Wait, or FLUSHALL as above.

## Commands

```
pnpm dev:server          # Hono HTTP under tsx watch (:7777)
pnpm dev:worker          # BullMQ run-grade + health workers under tsx watch
pnpm dev:web             # Vite dev server on :5173, HMR, proxies to :7777
pnpm web:build           # vite build → dist/web/
pnpm web:preview         # vite preview (serve dist/web)
pnpm enqueue-grade <url> [--paid]   # dev CLI: enqueue a grade job, bypassing HTTP
pnpm test                # unit tests (tests/unit/**)
pnpm test:integration    # testcontainers-backed integration tests
pnpm typecheck           # tsc --noEmit (both server + web tsconfigs)
pnpm build               # tsup + vite → dist/server.js + dist/worker.js + dist/web/
pnpm db:generate         # regenerate a migration after schema edits
pnpm db:migrate          # apply migrations to $DATABASE_URL
```

## Layout

```
src/
  config/env.ts          # lazy-parsed env Proxy; production requires all 4 LLM keys
  db/                    # Drizzle schema + client
  store/                 # GradeStore seam + PostgresStore; clearGradeArtifacts + getCookie
  scraper/               # library: static fetch + Playwright fallback + extractors + probes
  seo/                   # library: 10 pure-function signals + evaluateSeo composite
  llm/                   # library: 4 direct providers + MockProvider + factory + prompts + judge + flows
  scoring/               # library: pure heuristic scorers + letter grade + weights + composite
  accuracy/              # library: novel generator → blind-probe → per-provider verifier flow
  billing/               # library: Stripe client + price catalog + billing types
    types.ts             #   CheckoutSession + WebhookEvent + Payment types
    stripe-client.ts     #   Stripe SDK wrapper + env-bound factory
    prices.ts            #   $19 GEO Report price ID catalog
  queue/
    events.ts            #   pub/sub helpers: publishGradeEvent + subscribeToGrade
    queues.ts            #   BullMQ queue factories: grade, report, pdf
    redis.ts             #   ioredis factory
    workers/run-grade/           #   the main grade pipeline worker (free tier)
    workers/generate-report/     #   paid-tier: delta probes + rescore + recommender + reports row
  report/                # SSR report module (server-only — never bundled into web)
    render.tsx           #   renderReport(input) → full HTML document with inlined CSS
    report.css           #   standalone CSS (hybrid aesthetic), read at module init
    build-input.ts       #   pure transform: ReportRecord (joined rows) → ReportInput (view model)
    types.ts + token.ts + model-names.ts
    components/          #   Cover, Toc, Scorecard, RawResponses, AccuracyAppendix, SeoFindings, Recommendations, Methodology, Markdown
    pdf/                 #   render-pdf worker: reuses scraper's BrowserPool via withPage()
  server/
    app.ts               #   buildApp(ServerDeps) — composes middleware + routes + serveStatic
    server.ts            #   entrypoint: builds deps from env, starts @hono/node-server
    deps.ts              #   ServerDeps injection interface
    middleware/          #   clientIp, cookie, rate-limit, auth-rate-limit
    routes/              #   grades, grades-events (SSE), auth, billing, report
  web/
    main.tsx + App.tsx   #   React root + Router + layout
    styles.css           #   Tailwind v4 @import + @theme block with v1's color tokens
    pages/               #   LandingPage, LiveGradePage, EmailGatePage, NotFoundPage
    components/          #   Header, UrlForm, StatusBar, CategoryTile, ProbeLogRow, GradeLetter
    hooks/               #   useCreateGrade, useGradeEvents (EventSource → reducer)
    lib/                 #   types, grade-reducer (pure), api (typed fetch wrappers)
  worker/worker.ts       # BullMQ worker entrypoint — registers health + run-grade
  index.ts               # public re-export surface (library consumers)
scripts/
  enqueue-grade.ts       # dev CLI
tests/
  unit/                  # 561 tests, pnpm test
  integration/           # 105 tests, pnpm test:integration (testcontainers + Chromium)
  fixtures/              # shared test fixtures (e.g. tests/fixtures/report.ts)
docs/
  production-checklist.md   # deferred items to resolve before launch
  superpowers/
    specs/               # design docs (master spec + per-plan sub-specs)
    plans/               # per-plan implementation breakdowns
```

## Roadmap

| Plan | Scope | State |
| --- | --- | --- |
| 1 | Foundation: schema, queues, healthz, worker skeleton, CI, build | **Done** |
| 2 | Scraper library | **Done** |
| 3 | SEO evaluator (10 signals, deterministic) | **Done** |
| 4 | Scoring engine: LLM providers + prompts + judge + accuracy submodule | **Done** |
| 5 | Grade pipeline worker (wires scraper + core + SEO + judge) + dev CLI | **Done** |
| 6a | HTTP surface: `POST /grades`, `GET /grades/:id`, SSE, rate limit, anonymous cookie | **Done** |
| 6b | React terminal UI (landing, live grade, email gate) | **Done** |
| 7 | Auth (magic link, session cookie, quota lift) | **Done (2026-04-19)** |
| 8 | Paywall: Stripe checkout, webhook, recommendation LLM | **Done (2026-04-19)** |
| 8.5 | Credits Pack ($29/10 reports) | **Done (2026-04-19)** |
| 9 | Report rendering: React SSR + Playwright PDF + signed URLs | **Done (2026-04-19)** |
| 10 | Deploy: Railway services + add-ons | Pending |

## Relationship to v1

The original CLI lives at `~/repos/geo-grader/` and is local-only. v3 is a separate repo: it seeded a few ideas from v1's `src/core/` during Plan 1, then evolved independently. v1 is not a dependency.
