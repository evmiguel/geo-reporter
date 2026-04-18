# geo-reporter (v3)

A public, paywalled web app that grades websites on how well LLMs know them. Scrapes the site, runs LLM probes across six categories (Discoverability, Recognition, Accuracy, Coverage, Citation, SEO), and produces an HTML + PDF report with recommendations.

**Status:** early build. Foundation, scraper, and SEO evaluator are shipped. The end-to-end grading flow (LLM providers, judge, pipeline worker, HTTP routes, frontend, paywall, report rendering, deploy) is not wired up yet — see [Roadmap](#roadmap).

For the full architecture and the 17 locked-in design decisions, see [`docs/superpowers/specs/2026-04-17-geo-reporter-design.md`](docs/superpowers/specs/2026-04-17-geo-reporter-design.md). For working conventions and footguns, see [`CLAUDE.md`](CLAUDE.md).

## What runs today

| Surface | State |
| --- | --- |
| `GET /healthz` on `pnpm dev:server` | Works. Returns `{ ok, db, redis }` after pinging both. |
| `pnpm dev:worker` | Boots, registers a health queue worker, idles for jobs. |
| `scrape(url)` library (`src/scraper/`) | Works. Static fetch → Playwright fallback, extractors, discovery probes. No CLI. |
| `evaluateSeo(scrape)` library (`src/seo/`) | Works. 10 deterministic signals → `{ score, signals }`. No CLI. |
| `pnpm test` | 87 unit tests passing. |
| `pnpm test:integration` | Runs against Postgres/Redis via testcontainers + a local HTTP fixture + real Chromium. |
| `pnpm build` | Bundles `dist/server.js` and `dist/worker.js` with tsup. |
| `POST /grades`, SSE, rate limit, auth, Stripe, report UI | **Not implemented yet.** |

## Prerequisites

- Node **20.11+**
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

# .env at the repo root
cat > .env <<'EOF'
DATABASE_URL=postgres://geo:geo@localhost:54320/geo
REDIS_URL=redis://localhost:63790
NODE_ENV=development
PORT=7777
EOF

pnpm db:migrate
```

Then in two terminals:

```bash
pnpm dev:server   # http://localhost:7777/healthz
pnpm dev:worker
```

`curl http://localhost:7777/healthz` should return `{"ok":true,"db":true,"redis":true}`.

## Commands

```
pnpm dev:server          # Hono HTTP under tsx watch
pnpm dev:worker          # BullMQ worker under tsx watch
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
  config/env.ts          # lazy-parsed env Proxy (see CLAUDE.md footgun note)
  db/                    # Drizzle schema + client
  store/                 # GradeStore seam + PostgresStore (only impl)
  queue/                 # BullMQ queues, Redis factory, worker registry
  scraper/               # library-only: fetch + Playwright + extractors + probes
  seo/                   # library-only: 10 signals + evaluateSeo composite
  server/server.ts       # Hono entrypoint (currently /healthz only)
  worker/worker.ts       # BullMQ worker entrypoint
  index.ts               # public re-export surface
tests/
  unit/                  # included by pnpm test
  integration/           # testcontainers + real Chromium; pnpm test:integration
docs/superpowers/
  specs/                 # design docs (spec is source of truth)
  plans/                 # per-plan implementation breakdowns
```

## Roadmap

| Plan | Scope | State |
| --- | --- | --- |
| 1 | Foundation: schema, queues, healthz, worker skeleton, CI, build | **Done** |
| 2 | Scraper library | **Done** |
| 3 | SEO evaluator (10 signals, deterministic) | **Done** |
| 4 | Scoring engine: LLM providers + prompts + judge + accuracy submodule | Pending |
| 5 | Grade pipeline worker (wires scraper + core + SEO + judge) | Pending |
| 6 | Web service: `POST /grades`, SSE, rate limit, React terminal UI | Pending |
| 7 | Auth (magic link, session cookie, quota lift) | Pending |
| 8 | Paywall: Stripe checkout, webhook, recommendation LLM | Pending |
| 9 | Report rendering: React SSR + Playwright PDF + signed URLs | Pending |
| 10 | Deploy: Railway services + add-ons | Pending |

## Relationship to v1

The original CLI lives at `~/repos/geo-grader/` and is local-only. v3 is a separate repo: it seeded a few ideas from v1's `src/core/` during Plan 1, then evolved independently. v1 is not a dependency.
