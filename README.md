# geo-reporter (v3)

A public, paywalled web app that grades websites on how well LLMs know them. Scrapes the site, runs LLM probes across six categories (Discoverability, Recognition, Accuracy, Coverage, Citation, SEO), and produces an HTML + PDF report with recommendations.

**Status:** pipeline + HTTP surface shipped. The scoring pipeline runs; the Hono HTTP API is live (`POST /grades`, `GET /grades/:id`, SSE at `GET /grades/:id/events`) with rate limiting and anonymous cookies. The React frontend, auth, Stripe, report rendering, and deploy are still ahead — see [Roadmap](#roadmap).

**You can grade a real website end-to-end today** in two ways:
1. [**HTTP**](#running-a-grade-via-http) — `curl`-testable. Same path the React UI will use when Plan 6b lands.
2. [**Dev CLI**](#running-a-grade-from-the-cli) — `pnpm enqueue-grade <url>`, skips rate limit + cookie plumbing.

Both require API keys for the four supported LLM providers.

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
| `pnpm test` | 314 unit tests passing. |
| `pnpm test:integration` | 35 integration tests — testcontainers Postgres + Redis + MockProvider. |
| `pnpm build` | Bundles `dist/server.js`, `dist/worker.js`, and `dist/web/` with tsup + vite. |
| magic-link auth, Stripe checkout, report HTML/PDF | **Not implemented yet** (Plans 7–9). |

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
EOF

pnpm db:migrate
```

Then in two terminals:

```bash
pnpm dev:server   # http://localhost:7777  — Hono HTTP + SSE
pnpm dev:worker   # idles waiting for run-grade jobs
```

`curl http://localhost:7777/healthz` should return `{"ok":true,"db":true,"redis":true}`.

## Running a grade via HTTP

This is the path the React UI will take when Plan 6b ships. Everything is `curl`-testable today.

### Three-terminal workflow

**Terminal 1 — server:**
```bash
pnpm dev:server
```
Expected: `{"msg":"server listening","port":7777}`. Leave it running.

**Terminal 2 — worker:**
```bash
pnpm dev:worker
```
Expected: `{"msg":"worker started","workers":2}`. Leave it running.

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

The stream closes when the grade finishes (`done` or `failed`). A free-tier grade typically writes 25 probe rows and takes 30–90 seconds depending on provider latency.

**Reconnect after a drop**: just re-run the `curl /events` command. The endpoint rehydrates past state from the database, then resumes live events — no duplicates if the grade is still running, a single synthesized `done` event if it already finished.

## Running the React dev loop

Three terminals:

```bash
# Terminal 1
pnpm dev:server

# Terminal 2
pnpm dev:worker

# Terminal 3
pnpm dev:web
```

Open http://localhost:5173. Paste a URL, hit "grade", watch the live scorecard fill in as probes resolve.

The Vite dev server proxies `/grades/*` and `/healthz` to Hono, so the browser sees a single origin. Cookies, SSE, and rate limiting behave identically to production.

### What you'll see

- **Landing `/`** — URL input; submit navigates to `/g/:id`.
- **LiveGrade `/g/:id`** — 6 category tiles fill in live via SSE; chronological probe log below. On `done`, a big letter grade replaces the status bar.
- **EmailGate `/email`** — shown on 429. The form hits `/auth/magic` which 404s until Plan 7 ships (displays a "coming soon" message).
- **404 `*`** — any unknown route.

### Production build

```bash
pnpm build
node dist/server.js
```

One process serves API + SSE + the built React app on port 7777.

### Fetch the final scorecard

After the grade finishes:
```bash
curl -s -b /tmp/gg-cookies.txt http://localhost:7777/grades/$GRADE_ID | jq
# → { "id": "...", "url": "...", "status": "done", "overall": 77, "letter": "C+", "scores": {...} }
```

### Rate limit + 429

Free tier is 3 grades per (IP, cookie) per rolling 24h. The 4th returns:
```json
{
  "paywall": "email",
  "limit": 3,
  "used": 3,
  "retryAfter": 86397
}
```
(The `email` pathway unlocks an extra 10 grades once Plan 7 ships the magic-link verify flow. Until then, swap cookies or wait.)

## Running a grade from the CLI

The dev CLI (`scripts/enqueue-grade.ts`) skips the HTTP layer — no rate limit, no cookie dance. Useful for quick smoke tests when you're iterating on the worker.

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
- **`POST /grades` returns 400** → URL validation rejected it. Must be `http://` or `https://`. Full SSRF defense (DNS pinning, private-IP blocking) is on the production checklist; for local dev, `http://localhost:...` URLs are allowed.
- **`GET /grades/:id/events` returns 403** → cookie mismatch. The SSE endpoint requires the same cookie that created the grade. If you used `-c cookies.txt` in the POST, pass `-b cookies.txt` to the SSE request.
- **SSE stream hangs immediately then closes** → grade already finished (status `done` or `failed`). The endpoint synthesizes one terminal event and closes. Call `GET /grades/:id` for the final JSON.
- **Grade finalizes with `status='done'` but `scores.accuracy` is `null`** → expected. Happens when the scrape is sparse (< 500 chars) or the verifier can't judge from the scrape. Check `probes` rows with `category='accuracy' AND provider IS NULL` for the `reason` in metadata (`insufficient_scrape` | `all_null` | `all_failed`).
- **Grade finalizes with `status='failed'`** → look at the last `failed` event on the SSE stream (or Redis channel) for the error message. Typically a scrape producing < 100 chars of text (even after Playwright fallback).
- **Worker logs `ECONNREFUSED` during retry** → BullMQ retries 3× with exponential backoff. Each retry runs `clearGradeArtifacts(gradeId)` first for a clean slate; probe rows won't accumulate across attempts.

## Commands

```
pnpm dev:server          # Hono HTTP under tsx watch
pnpm dev:worker          # BullMQ run-grade + health workers under tsx watch
pnpm dev:web             # Vite dev server on :5173, HMR, proxies to :7777
pnpm web:build           # vite build → dist/web/
pnpm web:preview         # vite preview (serve dist/web)
pnpm enqueue-grade <url> [--paid]   # dev CLI: enqueue a grade job, bypassing HTTP
pnpm test                # unit tests (tests/unit/**)
pnpm test:integration    # testcontainers-backed integration tests
pnpm typecheck           # tsc --noEmit
pnpm build               # tsup → dist/server.js + dist/worker.js
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
  web/                   # React frontend: pages, components, hooks, reducer
  queue/
    events.ts            #   pub/sub helpers: publishGradeEvent + subscribeToGrade
    queues.ts            #   BullMQ queue factories
    redis.ts             #   ioredis factory
    workers/run-grade/   #   the main grade pipeline worker
  server/
    app.ts               #   buildApp(ServerDeps) — composes middleware + routes
    server.ts            #   entrypoint: builds deps from env, starts @hono/node-server
    deps.ts              #   ServerDeps injection interface
    middleware/          #   clientIp, cookie, rate-limit
    routes/              #   grades (POST + GET), grades-events (SSE)
  worker/worker.ts       # BullMQ worker entrypoint — registers health + run-grade
  index.ts               # public re-export surface
scripts/
  enqueue-grade.ts       # dev CLI
tests/
  unit/                  # included by pnpm test (286 tests)
  integration/           # testcontainers + MockProvider (35 tests)
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
| 7 | Auth (magic link, session cookie, quota lift) | Pending |
| 8 | Paywall: Stripe checkout, webhook, recommendation LLM | Pending |
| 9 | Report rendering: React SSR + Playwright PDF + signed URLs | Pending |
| 10 | Deploy: Railway services + add-ons | Pending |

## Relationship to v1

The original CLI lives at `~/repos/geo-grader/` and is local-only. v3 is a separate repo: it seeded a few ideas from v1's `src/core/` during Plan 1, then evolved independently. v1 is not a dependency.
