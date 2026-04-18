# geo-reporter (v3)

A public, paywalled web app that grades websites on how well LLMs know them. Scrapes the site, runs LLM probes across six categories (Discoverability, Recognition, Accuracy, Coverage, Citation, SEO), and produces an HTML + PDF report with recommendations.

**Status:** core pipeline shipped. Foundation, scraper, SEO evaluator, LLM scoring engine, and the BullMQ run-grade worker are all wired up. The public-facing HTTP surface (`POST /grades`, SSE, rate limit, React UI, paywall, report rendering, deploy) is not built yet — see [Roadmap](#roadmap).

**You can grade a real website end-to-end today** using the dev CLI (see [Running a grade from the CLI](#running-a-grade-from-the-cli)) — provided you have API keys for the four supported LLM providers.

For the full architecture and the 17 locked-in design decisions, see [`docs/superpowers/specs/2026-04-17-geo-reporter-design.md`](docs/superpowers/specs/2026-04-17-geo-reporter-design.md). For working conventions and footguns, see [`CLAUDE.md`](CLAUDE.md).

## What runs today

| Surface | State |
| --- | --- |
| `scrape(url)` library (`src/scraper/`) | Works. Static fetch → Playwright fallback, extractors, discovery probes. |
| `evaluateSeo(scrape)` library (`src/seo/`) | Works. 10 deterministic signals → `{ score, signals }`. |
| `src/llm/` — 4 providers + MockProvider + prompts + judge + flows | Works. Anthropic, OpenAI, Gemini, Perplexity clients; unified sparse/dense judge; self-gen + static-probe + coverage flows. |
| `src/scoring/` — pure scorers + composite | Works. Recognition, Citation, Discoverability heuristics; letter grade; `weightedOverall` with null-category renormalization. |
| `src/accuracy/` — generator + per-provider verifier + orchestrator | Works. `runAccuracy` returns `{ score, reason, probes, verifications }` with `ok`/`insufficient_scrape`/`all_null`/`all_failed` reasons. |
| BullMQ `run-grade` worker (`pnpm dev:worker`) | Works. Consumes `{ gradeId, tier }` jobs, runs the full pipeline, writes probes + scrape + grades, publishes SSE-ready events on Redis channel `grade:<id>`. |
| **`pnpm enqueue-grade <url>` dev CLI** | Works. Inserts a grades row + enqueues a `run-grade` job. See [Running a grade from the CLI](#running-a-grade-from-the-cli). |
| `GET /healthz` on `pnpm dev:server` | Works. Returns `{ ok, db, redis }`. |
| `pnpm test` | 255 unit tests passing. |
| `pnpm test:integration` | 27 integration tests — testcontainers Postgres + Redis + MockProvider (no real LLM calls in CI). |
| `pnpm build` | Bundles `dist/server.js` and `dist/worker.js` with tsup. |
| `POST /grades`, SSE HTTP endpoint, rate limit, React UI, Stripe | **Not implemented yet** (Plans 6–10). |

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
pnpm dev:server   # http://localhost:7777/healthz
pnpm dev:worker   # idles waiting for run-grade jobs
```

`curl http://localhost:7777/healthz` should return `{"ok":true,"db":true,"redis":true}`.

## Running a grade from the CLI

The dev CLI (`scripts/enqueue-grade.ts`) lets you grade a real URL end-to-end before the public HTTP surface lands in Plan 6. It inserts a `grades` row, enqueues a BullMQ `run-grade` job, and prints the gradeId plus a `redis-cli` command you can use to watch progress events stream in.

### Prerequisites

- Setup above completed: docker compose up, migrations applied, `.env` populated.
- **All four LLM API keys must be set** in `.env`. `buildProviders` throws at worker startup if any are missing.
- Playwright Chromium installed (only needed if the target site is JavaScript-rendered and the static fetch returns too little text).

### Three-terminal workflow

**Terminal 1 — start the worker:**
```bash
pnpm dev:worker
```
You'll see `{"msg":"worker started","workers":2}` (health + run-grade). Leave it running.

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

**Terminal 3 — watch progress events:**
```bash
redis-cli -p 63790 subscribe grade:3f2b8e01-...
```
You'll see a live stream:
```
{"type":"running"}
{"type":"scraped","rendered":false,"textLength":5820}
{"type":"probe.started","category":"seo","provider":null,"label":"title"}
{"type":"probe.completed","category":"seo","provider":null,"label":"title","score":100,"durationMs":0,"error":null}
...
{"type":"category.completed","category":"seo","score":90}
{"type":"probe.started","category":"recognition","provider":"claude","label":"prompt_1"}
{"type":"probe.completed","category":"recognition","provider":"claude","label":"prompt_1","score":85,...}
...
{"type":"done","overall":77,"letter":"C+","scores":{"discoverability":80,"recognition":75,"accuracy":60,"coverage":70,"citation":100,"seo":90}}
```

A free-tier grade typically writes 25 probe rows and takes 30–90 seconds depending on provider latency. Paid-tier writes 39 rows.

### Inspecting results afterward

```bash
# Connect to the dev Postgres
docker compose exec postgres psql -U geo geo

# Grade row
SELECT id, url, status, overall, letter, scores FROM grades ORDER BY created_at DESC LIMIT 1;

# Probe rows for that grade
SELECT category, provider, score, metadata->>'label' AS label
FROM probes WHERE grade_id = '<gradeId>' ORDER BY created_at;

# Scrape for that grade
SELECT rendered, length(text) FROM scrapes WHERE grade_id = '<gradeId>';
```

### Tier matrix (from the spec)

| Tier | Probing providers | Total probe rows | Notes |
| --- | --- | --- | --- |
| `free` | Claude + GPT | 25 | 10 SEO signals + 4 recognition + 2 citation + 2 discoverability + 4 coverage + 3 accuracy (1 generator + 2 verify) |
| `paid` | Claude + GPT + Gemini + Perplexity | 39 | Same categories, 4 probers instead of 2 |

Judge / generator / verifier always use Claude regardless of tier (see `docs/superpowers/specs/2026-04-17-geo-reporter-plan-5-grade-pipeline-design.md` §2 P5-3).

### When things go wrong

- **Worker logs `buildProviders: ANTHROPIC_API_KEY is not set`** → missing key(s) in `.env`. The worker won't boot without all four in production; in dev it defers the check to provider use.
- **Grade finalizes with `status='done'` but `scores.accuracy` is `null`** → expected. Happens when the scrape is sparse (<500 chars of text) or the verifier can't judge from the scrape. Check `probes` rows with `category='accuracy' AND provider IS NULL` for the `reason` in metadata (`insufficient_scrape` | `all_null` | `all_failed`).
- **Grade finalizes with `status='failed'`** → look at the last `failed` event on the Redis channel for the error message. Typically a scrape producing <100 chars of text (even after Playwright fallback).
- **Worker logs `ECONNREFUSED` during retry** → BullMQ retries 3× with exponential backoff. Each retry runs `clearGradeArtifacts(gradeId)` first for a clean slate; probe rows won't accumulate across attempts.

## Commands

```
pnpm dev:server          # Hono HTTP under tsx watch
pnpm dev:worker          # BullMQ run-grade + health workers under tsx watch
pnpm enqueue-grade <url> [--paid]   # dev CLI: enqueue a grade job
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
  config/env.ts          # lazy-parsed env Proxy; production requires all 4 LLM keys (Zod superRefine)
  db/                    # Drizzle schema + client
  store/                 # GradeStore seam + PostgresStore (only impl); clearGradeArtifacts for worker retry
  scraper/               # library: static fetch + Playwright fallback + extractors + discovery probes
  seo/                   # library: 10 pure-function signals + evaluateSeo composite
  llm/                   # library: 4 direct providers + MockProvider + factory + prompts + judge + flows
  scoring/               # library: pure heuristic scorers + letter grade + weights + composite
  accuracy/              # library: novel generator → blind-probe → per-provider verifier flow
  queue/
    events.ts            #   pub/sub helpers: publishGradeEvent + subscribeToGrade
    queues.ts            #   BullMQ queue factories + enqueueGrade/enqueueReport/enqueuePdf
    redis.ts             #   ioredis factory with sensible defaults
    workers/
      health.ts          #     placeholder health ping worker
      run-grade/         #     the main grade pipeline worker
  server/server.ts       # Hono entrypoint (currently /healthz only)
  worker/worker.ts       # BullMQ worker entrypoint — registers health + run-grade
  index.ts               # public re-export surface
scripts/
  enqueue-grade.ts       # dev CLI
tests/
  unit/                  # included by pnpm test
  integration/           # testcontainers + MockProvider; pnpm test:integration
docs/superpowers/
  specs/                 # design docs (master spec + per-plan sub-specs)
  plans/                 # per-plan implementation breakdowns
```

## Roadmap

| Plan | Scope | State |
| --- | --- | --- |
| 1 | Foundation: schema, queues, healthz, worker skeleton, CI, build | **Done** |
| 2 | Scraper library | **Done** |
| 3 | SEO evaluator (10 signals, deterministic) | **Done** |
| 4 | Scoring engine: LLM providers + prompts + judge + accuracy submodule | **Done** |
| 5 | Grade pipeline worker (wires scraper + core + SEO + judge) + dev CLI | **Done** |
| 6 | Web service: `POST /grades`, SSE, rate limit, React terminal UI | Pending |
| 7 | Auth (magic link, session cookie, quota lift) | Pending |
| 8 | Paywall: Stripe checkout, webhook, recommendation LLM | Pending |
| 9 | Report rendering: React SSR + Playwright PDF + signed URLs | Pending |
| 10 | Deploy: Railway services + add-ons | Pending |

## Relationship to v1

The original CLI lives at `~/repos/geo-grader/` and is local-only. v3 is a separate repo: it seeded a few ideas from v1's `src/core/` during Plan 1, then evolved independently. v1 is not a dependency.
