# GEO Reporter (v3) — Design Spec

**Date:** 2026-04-17
**Status:** Draft (pre-implementation)
**Location:** `v3/` — fresh independent project, seeds code from v1 (`../src/`) but evolves separately.
**Author:** brainstorming session (erika + claude)

---

## 1. Overview

**GEO Reporter** is a public-hosted web app that grades a website on how well Large Language Models know about it — Generative Engine Optimization. A visitor pastes a URL, gets a free score across six categories, and can unlock a deep PDF/HTML report with raw LLM responses and a prioritized recommendation plan for $19.

It is the public, paywalled successor to v1's local-only `geo-grader` CLI. v1 remains intact; v3 seeds its core from v1 as a starting point and diverges.

**Shipping surfaces:**

- Public web UI at `https://<domain>` with a terminal aesthetic (inherited from v1)
- Signed-URL report pages + downloadable PDFs
- Stripe-hosted checkout for one-off $19 report purchases

---

## 2. Goals

1. Let anyone paste a URL and see a six-category score within ~20s, free, without an account.
2. Convert a meaningful share of free graders into $19 report buyers by making the scorecard intriguing but the deep answer (raw LLM responses + recommendations) paywalled.
3. Extend v1's scoring rubric with (a) a sixth **SEO** category and (b) a scrape-grounded accuracy flow that tests whether LLMs actually know the site's real content.
4. Ship as a two-service Node app (web + worker) on Railway-class hosting; keep the engine logic pure and testable.

### Non-goals

- Multi-URL workspaces, projects, or dashboards (single-at-a-time only for MVP).
- Subscription billing (one-off $19 only).
- Mobile apps / native clients.
- BYOK (bring-your-own-key) — API keys are app-owned.
- Translating v1 changes back to v3 or vice versa — they evolve independently.

---

## 3. Decisions log

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Hosting | Railway/Fly/Render long-running container | Playwright + SSE + rate-limit state all need a long-running process |
| 2 | Deployment shape | Two services from one repo: `web` + `worker`, plus Redis + Postgres add-ons | Isolate Playwright blast radius, scale grading independently of HTTP |
| 3 | Execution model | BullMQ worker + Redis pub/sub; web exposes SSE that tails job progress | Survives restarts, retry/backoff for transient provider errors, horizontal scale |
| 4 | Repo relation to v1 | Fresh independent project in `v3/` — seeds code from `../src/` but no shared package | User explicitly asked for B; no long-term maintenance of two consumers |
| 5 | Scoring categories | 6: Discoverability, Recognition, Coverage, Accuracy, Citation, SEO | Adds SEO and renames v1's "Discovery" → "Discoverability" for clarity |
| 6 | Accuracy method | Scrape → generator LLM writes a site-specific question → probe target LLMs blind → judge vs scraped ground truth | Most defensible test of whether LLMs actually know the site's content |
| 7 | SEO rubric | Standard bundle of 10 deterministic signals (incl. JSON-LD, OG, `llms.txt`, sitemap) | Balanced depth without drifting into general SEO auditor territory |
| 8 | Scraping | Playwright with static-fetch fallback; homepage only | Fastest path that still handles SPAs correctly |
| 9 | Identity model | Anonymous (IP + signed httpOnly cookie) → email magic-link → Stripe-paid | Three layers; low friction at top, real identity at bottom |
| 10 | Free rate limit | 3 grades per (IP ∩ cookie) per **rolling** 24h; +10 after email verify | Low-cost demo moment, email-gate captures remarketable contacts |
| 11 | Pricing | $19 per-report one-off via Stripe Checkout (no subscription) | Clean impulse-buy, no churn machinery |
| 12 | Multi-URL UX | Single-at-a-time only; no bulk-paste feature in MVP | Smallest feature that still lets the paywall be enforced per grade |
| 13 | Report format | Both: HTML at `/report/:id?t=<token>` + PDF via Playwright `page.pdf()` | Playwright is already in-stack; PDF nearly free |
| 14 | Report contents | 7 sections: cover, scorecard, raw LLM responses, accuracy appendix, SEO findings, recommendation plan, methodology | Covers the "output from the search created by the LLMs" and "recommendation plan" the user called out |
| 15 | LLM provider keys | App-owned env vars, not BYOK. Free scores run a subset (e.g. Claude + GPT); paid reports run full 4-provider matrix | Prevents free-tier token abuse from destroying margin |
| 16 | DB | Postgres via Drizzle ORM | Natural fit on Railway; maps cleanly from v1's store seam |
| 17 | Visual direction | Inherit v1's terminal aesthetic (orange primary, green pass, dim grays, mono typeface); extend to landing/report/checkout surfaces | Already validated in v1; no reason to re-explore |

---

## 4. Architecture

### 4.1 Services

Two processes from the same codebase, plus two managed add-ons:

```
 ┌────────── web service (Hono) ──────────┐
 │  HTTP + SSE + Stripe webhook + auth    │
 └────────┬────────┬──────────────────────┘
          │        │
   enqueue│        │subscribe (pub/sub)
          ▼        ▲
        ┌──────────┴──────┐    ┌──────────────────┐
        │      Redis      │    │     Postgres     │
        │  queue + pub/sub│    │  (Drizzle ORM)   │
        └──────▲──────────┘    └────▲─────────────┘
               │ pull               │ write
               │                    │
 ┌─────────────┴──── worker service (Node) ──────────────┐
 │  Playwright pool · core engine · SEO · recommendation │
 └────────────────────────────────────────────────────────┘
```

**Web service** (`node dist/server.js`): Hono HTTP app. Renders React static bundle, serves API, holds SSE connections. No Playwright.

**Worker service** (`node dist/worker.js`): BullMQ worker. Runs the Playwright browser pool, LLM probes, judge, SEO evaluator, and report rendering (for both HTML and PDF). Writes results to Postgres and publishes progress to Redis channels.

Both services share the same source tree. The worker is a separate Railway service — not a child process — so it has its own container, its own lifecycle, and Playwright's Chromium can live alongside Chrome's system deps without bloating the web image.

### 4.2 Source layout

```
v3/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── playwright.config.ts
├── vite.config.ts
├── vitest.config.ts
├── src/
│   ├── core/                    ← seeded from v1 src/core, extended
│   │   ├── providers/           anthropic, openai, gemini, perplexity, openrouter
│   │   ├── prompts.ts
│   │   ├── judge.ts
│   │   ├── scoring.ts           recognition, citation, discoverability heuristics
│   │   ├── types.ts
│   │   └── accuracy/            NEW: question generator + answer verifier
│   │       ├── generator.ts
│   │       └── verifier.ts
│   ├── seo/                     NEW: deterministic evaluator (10 signals)
│   │   ├── signals/             one file per signal for testability
│   │   └── index.ts
│   ├── scraper/                 NEW
│   │   ├── fetch.ts             plain fetch + text extraction
│   │   ├── render.ts            Playwright fallback
│   │   ├── extractors.ts        JSON-LD, OG, meta, sitemap, robots, llms.txt
│   │   └── index.ts             entrypoint with fallback logic
│   ├── db/                      Drizzle schema + migrations
│   │   ├── schema.ts
│   │   └── migrations/
│   ├── store/                   repository interface + Postgres impl
│   ├── queue/                   BullMQ producer + worker registration
│   │   ├── producer.ts
│   │   ├── workers/
│   │   │   ├── run-grade.ts
│   │   │   └── generate-report.ts
│   │   └── events.ts            publish helpers
│   ├── server/
│   │   ├── app.ts               Hono app composition
│   │   ├── server.ts            entrypoint
│   │   ├── middleware/
│   │   │   ├── rate-limit.ts
│   │   │   ├── auth.ts          reads cookie + optional session
│   │   │   └── stripe-signature.ts
│   │   └── routes/
│   │       ├── grades.ts        POST /grades, GET /grades/:id/events
│   │       ├── report.ts        GET /report/:id, GET /report/:id.pdf
│   │       ├── auth.ts          magic-link issue + verify
│   │       └── billing.ts       checkout + webhook
│   ├── auth/                    magic-link tokens, session cookies
│   ├── billing/                 Stripe client, checkout session builder
│   ├── report/                  HTML template + PDF renderer
│   │   ├── template.tsx         React SSR for the report page
│   │   ├── render-html.ts
│   │   └── render-pdf.ts        Playwright page.pdf()
│   └── web/                     Vite React app (terminal aesthetic)
│       ├── pages/               Landing, LiveGrade, Report, EmailGate, Pay
│       ├── components/
│       └── styles.css
├── tests/
│   ├── unit/                    vitest
│   └── e2e/                     Playwright smoke
└── dist/
```

### 4.3 End-to-end trace — free grade

1. Browser `POST /grades { url }` (fetch with cookie).
2. Rate-limit middleware reads `rate_limit_buckets` sorted set for key `ip:<ip>+cookie:<cookie>`; counts entries in the last 86,400s; if ≥3 (or ≥13 when the cookie maps to a verified email), returns `429 { paywall: 'email' | 'pay' }`. On pass, appends a new entry scored by `now()`.
3. Web inserts `grades` row with `status='queued'`, enqueues BullMQ `run-grade` job `{ gradeId, tier: 'free' | 'paid' }`, returns `{ gradeId }`.
4. Browser opens `GET /grades/:id/events` (SSE). Server subscribes to Redis channel `grade:<id>` and pipes messages as SSE `data:` frames.
5. Worker picks up the job:
   - a. Scrape: `scraper.fetch(url)`; if rendered text < 1000 chars, fall back to `scraper.render(url)` (Playwright, wait for network-idle). Persist to `scrapes`.
   - b. Emit `{ phase: 'scraped' }` over Redis.
   - c. SEO signals run in parallel against the scrape (pure, no LLM). Each signal writes a `probes` row with `category='seo'`.
   - d. Recognition / Coverage / Citation / Discoverability probes: for each configured provider (free tier = 2 providers; paid tier = 4), fire the v1-inherited probe prompt, persist `probes` row on resolution, emit progress event.
   - e. Accuracy: generator LLM receives scraped text excerpt → emits a single specific question → each target LLM answers the question without seeing the scrape → verifier LLM compares each answer against the scrape, scores 0–100 per provider.
   - f. Judge: aggregate raw probe outputs into per-category scores (reuses v1 scoring.ts for Recognition/Citation/Discoverability heuristics; judge LLM for Coverage/Accuracy).
   - g. Finalize: compute weighted overall, assign letter grade, write to `grades`, emit `{ phase: 'done' }`.
6. Browser renders the 6-category scorecard; CTAs: "Get the full report — $19".

### 4.4 End-to-end trace — paid report

1. User on scorecard clicks CTA → `POST /billing/checkout { gradeId }`.
2. Server creates a Stripe Checkout Session (`mode: 'payment'`, line item: $19 GEO Report, `metadata: { gradeId, userId? }`); returns the session URL.
3. Browser redirects to Stripe-hosted checkout.
4. On completion, Stripe calls `POST /billing/webhook`. Server validates the signature, records `stripe_payments` row, enqueues `generate-report` job.
5. Worker `generate-report`:
   - a. If tier at grading time was `free` (only 2 providers ran), run the remaining providers to complete the 4-provider matrix. Write additional probe rows.
   - b. Run the **recommendation** LLM: input = URL, per-category scores, every failing SEO signal, the accuracy Q&A, raw LLM descriptions, and the scraped page text. Output = JSON array of 5–8 recommendations `{ title, category, impact: 1–5, effort: 1–5, rationale, how }`. Persist to `recommendations`.
   - c. Write a `reports` row with a random signed token (32 bytes, hex).
6. Stripe redirects browser to `https://<domain>/report/:id?t=<token>`.
7. Report route validates the token (constant-time compare against `reports.token`), SSR-renders the 7-section React template, returns HTML.
8. "Download PDF" link hits `GET /report/:id.pdf?t=<token>`. Server, running in the web process, calls into a tiny Playwright helper that takes the same token, opens the HTML URL (with `X-Report-Internal-Key` header), and returns `page.pdf()` as the response body.
   - Because Playwright lives in the worker service, the web service emits a `render-pdf` job and waits on its completion (BullMQ supports this). Alternatively, a dedicated "pdf" worker subscribes just to that queue. MVP: re-use the main worker.

**Interpretation calls locked in during Plan 5 brainstorming (2026-04-17):** see the full sub-spec at [`2026-04-17-geo-reporter-plan-5-grade-pipeline-design.md`](./2026-04-17-geo-reporter-plan-5-grade-pipeline-design.md). Summary:

- **Dev CLI + pub/sub pair:** ship `scripts/enqueue-grade.ts` and `src/queue/events.ts` (with BOTH publisher and subscriber helpers) so the worker is demo-able end-to-end before Plan 6's HTTP layer exists.
- **Specialty provider roles:** Claude plays the Coverage judge, Accuracy generator, and Accuracy verifier. Self-judging bias accepted for MVP.
- **Persistence timing:** write-through — each probe row lands in Postgres as its LLM call resolves; `grades` row finalized last. On BullMQ retry, worker calls `clearGradeArtifacts(gradeId)` first for a clean slate.
- **Category orchestration:** SEO runs first (synchronous, instant first progress tick); the five LLM categories then run in parallel via `Promise.all`.
- **SSE event schema:** per-probe granularity — `running`, `scraped`, `probe.started`, `probe.completed`, `category.completed`, `done`, `failed` — published on Redis channel `grade:<id>`.
- **Probe-row mapping:** Accuracy = 1 generator row + N answer rows (the generator visible as a first-class probe). Coverage = 2N rows with per-probe judge accuracy+coverage averaged into each row's `score`; no separate judge-summary row. `provider=null` remains reserved for SEO signals + accuracy-skipped placeholders.
- **Error policy — always finalize:** hard-fail only on DB/Redis down, scrape producing < 100 chars even after Playwright, or every LLM call failing. Per-probe errors record to the row and keep going; partial grades are preferred over blank failure pages.

---

## 5. Scoring engine

### 5.1 Categories and weights

| # | Category | Weight | Computed by |
|---|---|---|---|
| 1 | Discoverability | 30% | Recommendation-hint heuristics on an open-ended "what's the best X for Y" probe (inherited from v1's Discovery). Renamed for clarity. |
| 2 | Recognition | 20% | Heuristics on a "what do you know about <brand>" probe (v1's scoring.ts). |
| 3 | Accuracy | 20% | **New flow** — generator → blind probes → verifier LLM vs scrape. |
| 4 | Coverage | 10% | Judge LLM on Coverage prompt outputs, comparing claims to scrape summary. |
| 5 | Citation | 10% | Canonical-URL regex heuristics (v1's scoring.ts). |
| 6 | SEO | 10% | Deterministic signal evaluator (see §5.4). |

Weights are named constants in `core/types.ts` and displayed in the methodology section of the report. Discoverability stays at 30% because it's the truest GEO signal — does your site surface organically when asked a relevant question.

### 5.2 Tiered provider matrix

| Tier | Providers |
|---|---|
| Free | Claude + GPT |
| Paid | Claude + GPT + Gemini + Perplexity |

Token cost of a free grade stays bounded; buying the report triggers the remaining two providers' probes to complete the matrix (see §4.4 step 5a).

### 5.3 Accuracy flow (detailed)

Four LLM calls per paid grade (two per free grade):

1. **Generator** (1 call, cheap model). Input: scraped homepage text (truncated to ~4k tokens). Instruction: "Write one specific factual question a visitor would reasonably ask about this company that the scraped content clearly answers. Return only the question." Output: single question string.
2. **Probe** (N provider calls). For each target provider: send the question with no context. Capture response verbatim.
3. **Verifier** (1 judge call per provider, or one batched call). Input: scrape excerpt + question + each provider's answer. Instruction: "For each answer, return `{ provider, correct: true|false, confidence: 0–1, rationale }` based strictly on the scraped content. If the scrape doesn't support a definitive judgment, return `correct: null`." Null answers are dropped from the denominator.
4. **Score**: `accuracy = correct_count / valid_count × 100`.

Edge cases:
- Generator produces a question the scrape doesn't actually answer → verifier returns all `null` → accuracy falls back to v1's pre-scrape method for that grade, flagged in the report.
- Scrape is empty or < 500 chars → accuracy = `null`, reported as "Insufficient scrape — accuracy unscored"; overall grade recomputed without the accuracy slice.

**Interpretation calls locked in during Plan 4 brainstorming (2026-04-17):** see the full sub-spec at [`2026-04-17-geo-reporter-plan-4-scoring-engine-design.md`](./2026-04-17-geo-reporter-plan-4-scoring-engine-design.md). Summary:

- **Provider set:** 4 direct clients (Anthropic, OpenAI, Gemini, Perplexity) + `MockProvider`. OpenRouter is out of scope — BullMQ retries cover its fallback role.
- **Module layout:** three top-level siblings — `src/llm/` (network-touching), `src/scoring/` (pure math), `src/accuracy/` (novel flow). Enforces the network-vs-pure boundary at the filesystem level.
- **Scrape → judge bridge:** flat `GroundTruth` type stays (ported from v1); one `toGroundTruth(url, scrape)` helper is the only code that touches `ScrapeResult`. Judge and prompts remain near-verbatim from v1.
- **Accuracy verifier:** one verifier call **per provider**, in parallel. Batched alternative rejected — a single bad parse zeroing the whole category is a credibility risk not worth saving 1–3 cheap-model calls.
- **Sparse/dense judge:** one unified judge prompt with a conditional clause, replacing v1's two ~80%-duplicated builders. `isSparseGroundTruth(gt)` picks the branch.
- **Cost tracking:** providers return `{ inputTokens, outputTokens }` only. Dollar math and `prices.ts` dropped — price tables drift and don't belong in a library module.
- **Flow functions in Plan 4:** `runStaticProbe`, `runSelfGenProbe`, `runCoverageFlow`, `runAccuracy` live in Plan 4 (not Plan 5). Plan 5 becomes pipeline plumbing over a testable engine, not a bundle of category-specific logic.

### 5.4 SEO rubric (10 signals)

Each signal returns `{ pass: boolean, weight: number, detail: string }`. Per-signal weights are uniform at 10 for MVP; the category score is a simple `passed_weight / total_weight × 100`.

| Signal | Detail example |
|---|---|
| `<title>` present and non-generic | "`<title>` is missing" / "`<title>` is 'Home'" |
| `meta description` present and ≥50 chars | — |
| `<link rel=canonical>` present | — |
| JSON-LD block parseable, type is one of Organization/Product/WebSite | "No JSON-LD found" / "JSON-LD is invalid JSON" |
| Open Graph: `og:title`, `og:description`, `og:image` all present | lists missing ones |
| Twitter card `twitter:card` present | — |
| `robots.txt` doesn't disallow `GPTBot`/`ClaudeBot`/`PerplexityBot` via `/` | lists which user-agent is blocked |
| `sitemap.xml` reachable (200) | — |
| `llms.txt` reachable (200) | — |
| Exactly one `<h1>` and at least one `<h2>` | — |

Per-signal failures surface as specific recommendations in the paid report ("Add `og:image` — your homepage has none").

**Interpretation calls locked in during Plan 3 brainstorming (2026-04-17):**

- **Title "non-generic":** the whole trimmed title (case-insensitive) must not exactly match `home`, `index`, `untitled`, `welcome`, or `default`. Titles that *contain* those words (e.g. `Home | Acme Widgets`) pass. The check is equality, not substring, to keep false-fails low.
- **Robots.txt absent:** a 404 on `/robots.txt` counts as **pass**, not fail. No robots.txt means no crawl restrictions — that's the permissive default and we're grading whether LLMs can crawl, not whether the site ships a robots file.
- **JSON-LD `@graph` traversal:** a block may be a single `@type` object, an array of objects, or a `@graph` wrapper containing multiple objects. Pass if any `@type` anywhere in the block matches `Organization`, `Product`, or `WebSite`.
- **Robots parsing library:** `robots-parser` (npm). Handles the edge cases (wildcard UA, Allow vs Disallow precedence, most-specific-match) that a hand-rolled check would get wrong.

---

## 6. Scraper

### 6.1 Pipeline

```
url ─▶ plain fetch (GET, 10s timeout, text/html)
         │
         ▼
     parse DOM
         │
         ▼
  visible text < 1000 chars?
   ┌── yes ──────────▶  Playwright pool: page.goto(url, { waitUntil: 'networkidle' })
   │                         │
   │                         ▼
   │                    rendered DOM
   │                         │
   └── no ─────────────────┐│
                            ▼▼
                 structured-data extractors
                            │
                            ▼
     { html, text, jsonld[], og, meta, headings, linkCanonical,
       robots, sitemap, llmsTxt }
                            │
                            ▼
                  persist to `scrapes` row
```

### 6.2 Extractor responsibilities (`scraper/extractors.ts`)

- `extractJsonLd(html)` → all `<script type="application/ld+json">` blocks parsed; returns array, drops unparseable.
- `extractOG(html)` → `{ title, description, image, type, url }`.
- `extractMeta(html)` → `{ title, description, canonical, twitterCard, viewport }`.
- `extractHeadings(html)` → `{ h1: string[], h2: string[] }`.
- `fetchRobots(origin)` → `string | null` (HTTP 200 required).
- `fetchSitemap(origin)` → `{ present: boolean, url: string }`.
- `fetchLlmsTxt(origin)` → `{ present: boolean }`.

All extractors are pure functions over strings; tests use fixture HTML in `tests/unit/scraper/fixtures/`.

### 6.3 Playwright pool

Single shared Chromium instance. Concurrency limit: 2 pages at a time (Railway worker dyno memory budget). Page timeout: 15s. On timeout or error, fall through with whatever the plain fetch produced and set `scrapes.rendered = false`.

---

## 7. Paywall + identity

### 7.1 Anonymous tier

- Every request without a session cookie is issued a signed httpOnly cookie `ggcookie=<random>.<hmac>` on first response.
- Rate-limit key: `bucket:ip:<ip>+cookie:<cookie>`.
- Implementation: Redis sorted set; each grade request `ZADD key <now> <uuid>` and `ZREMRANGEBYSCORE key 0 <now-86400>`; count via `ZCARD`.
- If count ≥ 3 and cookie has no associated verified email → respond `429 { paywall: 'email' }`.

### 7.2 Email tier (magic-link)

> **Sub-spec:** See `docs/superpowers/specs/2026-04-19-geo-reporter-plan-7-auth-design.md` for the Plan 7 design — brainstormed 2026-04-19, shipped in Plan 7.

- Request at `POST /auth/magic { email }` → issue a 6-hour signed token, send email via a provider (Resend or Postmark; TBD at implementation time).
- `GET /auth/verify?t=<token>` → if valid and not expired, upsert `users` row and bind the current cookie to the user. Sets an additional long-lived `ggsession` cookie.
- While bound, the per-key free quota rises to 13 (3 anonymous + 10 email).
- If count ≥ 13 → `429 { paywall: 'pay' }`. No free grades after that per rolling 24h.

### 7.3 Paid tier

> **Sub-spec:** See `docs/superpowers/specs/2026-04-19-geo-reporter-plan-8-stripe-paywall-design.md` for the Plan 8 design — brainstormed 2026-04-19, shipped in Plan 8.

> **Credit packs (added 2026-04-19).** Alongside the $19 one-off, users can buy 10 credits for $29 via a separate Stripe Checkout product. Each credit redeems for one full paid report at any time (same `generate-report` pipeline). Email verification is required to hold credits (balance portability across cookies/devices). Rate-limit tier rises to 10/24h while `users.credits > 0`. Email-only verification no longer grants a +10 bonus — verified email = identity only. See `docs/superpowers/specs/2026-04-19-geo-reporter-credits-pack-design.md`.

- Stripe Checkout Session: `mode: 'payment'`, single $19 line item, `metadata.gradeId` set.
- Webhook on `checkout.session.completed` verifies signature, looks up the grade, enqueues `generate-report`. Idempotent by `session.id`.
- Successful payment unlocks `/report/:id?t=<token>`. No account required — token in the URL is the capability. A user-bound grade also shows up at `/my/reports` once email-bound.
- Refunds via Stripe admin (manual for MVP). Refund webhook just marks `stripe_payments.status='refunded'`; existing signed URLs keep working (MVP simplification; documented in the methodology page).

### 7.4 Abuse considerations

- IP + cookie double-keys the bucket, so clearing cookies doesn't fully reset (IP still counts) and changing IP (VPN) doesn't fully reset (cookie still counts). A determined abuser must do both — and they still can't access paid reports without paying.
- Bot protection for the `POST /grades` endpoint: header `Sec-Fetch-Site=same-origin` + basic in-middleware detection; escalate to Turnstile if we see abuse in production. Not MVP.

---

## 8. Report

### 8.1 HTML report

- Rendered server-side via React SSR into a single static HTML document with inlined CSS. No client JS except a "Download PDF" button.
- Route: `GET /report/:id?t=<token>`. Server validates token in constant time; on mismatch returns 404 (not 401, to avoid advertising the endpoint).
- Fully self-contained so PDF generation doesn't race asset loads.

### 8.2 PDF report

- `GET /report/:id.pdf?t=<token>` validates the token, then enqueues a `render-pdf` job with `{ gradeId, token }` and awaits its completion (BullMQ's job-completion promise on the web side). No Playwright in the web process.
- The worker picks up `render-pdf`, SSR-renders the same HTML that route `/report/:id` would serve (via a shared `render-html.ts` module), calls `page.setContent(html, { waitUntil: 'load' })`, applies print CSS, and returns `page.pdf({ format: 'A4', printBackground: true })` as the job result (a `Buffer`).
- Web service receives the buffer, responds: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="geo-report-<domain>-<YYYYMMDD>.pdf"`.
- Job timeout: 30s; on timeout, return `504` with a retry hint.

### 8.3 Content (7 sections)

1. **Cover.** URL, favicon-as-logo, letter grade, overall numeric, timestamp, "Report for <email>" if bound.
2. **Scorecard.** 6 category cards with per-category score, 1-line summary, and small sparkline of the score (purely decorative for MVP).
3. **Raw LLM responses.** Per category, per provider: the exact prompt and the exact response. Collapsible in HTML, paginated in PDF.
4. **Accuracy appendix.** The generated question, the scraped excerpt used as ground truth, each provider's answer, verifier verdict.
5. **SEO findings.** 10 signals as ✓/✗ with detail strings.
6. **Recommendation plan.** 5–8 cards sorted by `impact × (6 - effort)`; each card: title, category, impact stars, effort stars, rationale paragraph, concrete "how" steps.
7. **Methodology.** One page explaining the rubric, weights, and that "we call this a grade, not an audit — it's a point-in-time snapshot of what LLMs say about your site."

### 8.4 Recommendation LLM (one call)

- Model: paid-tier default (e.g. Claude Sonnet).
- Input: JSON blob of `{ url, scores, failingSeoSignals, accuracyQuestion, accuracyAnswers, llmDescriptions, scrapeText }`.
- Output: JSON array of recommendations conforming to a Zod schema; validate before persisting.
- Failure mode: if model returns invalid JSON or < 5 recommendations, retry once with a stricter prompt; if still failing, persist what we got and flag the report with a banner ("Recommendations limited — try refreshing this report page").

---

## 9. Data model

Postgres via Drizzle. Schema file: `src/db/schema.ts`. Migrations generated via `drizzle-kit`.

```ts
users                // one row per verified email
  id uuid pk
  email text unique
  createdAt timestamptz

cookies              // one row per issued ggcookie
  cookie text pk
  userId uuid null fk → users.id   -- null = anonymous
  createdAt timestamptz

grades
  id uuid pk
  url text
  domain text                      -- normalized (host only, no www.)
  tier text                        -- 'free' | 'paid'
  cookie text fk → cookies.cookie
  userId uuid null fk → users.id
  status text                      -- 'queued' | 'running' | 'done' | 'failed'
  overall int null
  letter text null
  scores jsonb null                -- { discoverability, recognition, ... }
  createdAt, updatedAt timestamptz

scrapes
  id uuid pk
  gradeId uuid fk → grades.id unique
  rendered bool                    -- true if Playwright ran
  html text                        -- raw HTML
  text text                        -- extracted visible text
  structured jsonb                 -- jsonld, og, meta, headings, robots, sitemap, llmsTxt
  fetchedAt timestamptz

probes
  id uuid pk
  gradeId uuid fk → grades.id
  category text                    -- enum: discoverability|recognition|coverage|accuracy|citation|seo
  provider text null               -- null for SEO signals
  prompt text
  response text
  score int null
  metadata jsonb                   -- signal name, judge rationale, etc.
  createdAt timestamptz

recommendations
  id uuid pk
  gradeId uuid fk → grades.id
  rank int
  title text
  category text
  impact int                       -- 1..5
  effort int                       -- 1..5
  rationale text
  how text
  createdAt timestamptz

reports
  id uuid pk                       -- same as gradeId for simplicity
  gradeId uuid unique fk → grades.id
  token text                       -- 32 random bytes hex, per report
  createdAt timestamptz

stripe_payments
  id uuid pk
  gradeId uuid fk → grades.id
  sessionId text unique            -- Stripe checkout session id
  status text                      -- 'pending' | 'paid' | 'refunded' | 'failed'
  amountCents int
  currency text
  createdAt, updatedAt timestamptz

magic_tokens
  id uuid pk
  email text
  tokenHash text                   -- sha256 of the token
  expiresAt timestamptz
  consumedAt timestamptz null
  cookie text null fk → cookies.cookie   -- which browser requested it
```

Redis (no schema — listed for completeness):
- `queue:grade` / `queue:report` / `queue:pdf` — BullMQ keys
- `bucket:<key>` — sorted set for rate limits
- `grade:<id>` — pub/sub channel for SSE fan-out

---

## 10. API surface

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/grades` | POST | Start a grade | cookie (rate-limited) |
| `/grades/:id` | GET | Fetch final grade JSON | cookie or signed token |
| `/grades/:id/events` | GET (SSE) | Live progress stream | cookie |
| `/auth/magic` | POST | Request a magic-link email | — |
| `/auth/verify` | GET | Consume a magic token | — |
| `/billing/checkout` | POST | Create Stripe Checkout session | cookie |
| `/billing/webhook` | POST | Stripe webhook receiver | Stripe signature |
| `/report/:id` | GET | Render HTML report | signed token |
| `/report/:id.pdf` | GET | Render PDF | signed token |
| `/my/grades` | GET | List of grades for the bound user | session cookie |

Inter-service communication uses BullMQ jobs only — no private HTTP between web and worker.

**Interpretation calls locked in during Plan 6a brainstorming (2026-04-18):** see the full sub-spec at [`2026-04-18-geo-reporter-plan-6a-http-surface-design.md`](./2026-04-18-geo-reporter-plan-6a-http-surface-design.md). Summary:

- **Plan 6 split:** Plan 6a ships the backend (`POST /grades`, `GET /grades/:id`, `GET /grades/:id/events`); Plan 6b ships the React frontend separately. Backend is `curl`- and SSE-testable on its own.
- **Anonymous cookie:** plain UUID v4, `httpOnly`, `sameSite=Lax`, `secure`-in-production, 1-year expiry. HMAC signing deferred to launch hardening (production checklist).
- **Client IP:** trust `X-Forwarded-For` first value; fall back to socket address. Trusted-proxy allow-list deferred to production checklist.
- **Rate limit:** Redis sorted-set bucket keyed `bucket:ip:<ip>+cookie:<cookie>`, 24h window. Anonymous = 3; when `cookies.userId IS NOT NULL` = 13. Lookup implemented now so Plan 7's magic-link verify just sets `userId` and the limit auto-upgrades. Atomic-Lua-script upgrade deferred to production checklist. 429 body: `{ paywall, limit, used, retryAfter }`.
- **SSE hydration:** every connection to `GET /grades/:id/events` SELECTs scrape + probes + grade row, synthesizes past events, then subscribes to Redis for live events. No `Last-Event-ID` replay — reconnect always fully rehydrates.
- **SSE auth:** cookie must match `grades.cookie`; 403 otherwise. Signed-URL shareability is a Plan 9 concern (report routes).
- **URL validation:** Zod + `http:`/`https:` scheme check only. Full SSRF defense (DNS-pinning) is on the production checklist — must land before public launch.
- **Concurrent grades per cookie:** allowed; rate limit is the cap. Redirect-to-in-flight UX is a frontend concern.
- **Libraries + conventions:** `@hono/zod-validator` for request bodies; Hono's `cors` middleware active only in development (allowing `http://localhost:5173`, `credentials: true`); `app.fetch()` for unit tests, real HTTP via `@hono/node-server` only for the SSE live-events integration test.

---

## 11. Frontend

Vite + React + Tailwind, terminal aesthetic inherited from v1.

Pages:
- `/` — **Landing.** Hero with URL input + "Grade" button, one-liner pitch, three sample grades visible as proof. Below the fold: methodology teaser, CTA for report.
- `/g/:id` — **LiveGrade.** Phases bar, category tiles, probe list (collapsed rows that expand as they resolve). Persistent "Get the full report — $19" bar pinned to the bottom once `status='done'`.
- `/email` — **EmailGate.** Modal page after hitting the 3/24h anonymous limit.
- `/report/:id?t=` — **Report.** The 7-section template in the same terminal frame; "Download PDF" CTA.
- `/my` — **MyReports.** List for users with a bound session.
- `/settings` — **Settings.** (Post-MVP.)

Components inherited in spirit from v1: `GradeLetter`, `CategoryCard`, `ProbePanel`, `Sidebar`, `Layout`. Re-implemented in v3 to match the new API shape (no `AdHocRepl` in MVP — that was a v1 feature).

**Interpretation calls locked in during Plan 6b brainstorming (2026-04-18):** see the full sub-spec at [`2026-04-18-geo-reporter-plan-6b-frontend-design.md`](./2026-04-18-geo-reporter-plan-6b-frontend-design.md). Summary:

- **Plan 6 split:** Plan 6a shipped the HTTP surface (merged `156391d`); Plan 6b is the React frontend standalone.
- **Routes shipped:** `/`, `/g/:id`, `/email`, `*` (404 fallback). `/report/:id` is Plan 9, `/my/grades` is Plan 7, `/settings` is post-MVP.
- **Layout:** sidebar-less single column with a minimal top header. Sidebar earns its space once Plan 7 adds `/my/grades`.
- **LiveGrade page:** 2×3 category-tile grid at the top (scores fill in live as `category.completed` events arrive) + chronological probe log below (rendered from `probe.started` + `probe.completed` events). When `phase === 'done'`, a large letter-grade display replaces the status bar.
- **Source layout:** `src/web/` for frontend, `dist/web/` for build output. Two-terminal dev (Vite on :5173 proxies API/SSE to Hono on :7777); production Hono adds `serveStatic` catch-all for the built assets. Frontend-on-CDN deferred to the production checklist.
- **Data:** native `EventSource` with `withCredentials: true` for SSE; plain `fetch` + React hooks (no TanStack Query); React Router v6.
- **State:** pure `reduceGradeEvents(state, event)` reducer + thin `useGradeEvents(gradeId)` hook. Separates logic from React the same way Plans 4/5 separate flows from orchestration.
- **Styling:** Tailwind v4 with `@theme` block ported verbatim from v1 (`#0a0a0a` bg, `#ff7a1a` brand, `#5cf28e` good, JetBrains Mono).
- **Testing:** Vitest + React Testing Library + happy-dom. No Playwright — its value unlocks at Plan 10's Stripe/report scope.
- **Component rename from §11:** v3 uses `CategoryTile` (not `CategoryCard`), `ProbeLogRow` (not `ProbePanel`), `Header` (not `Sidebar`); `Layout` is inlined into `App.tsx` with React Router's `<Outlet/>`. `AdHocRepl` stays out.

---

## 12. Testing

- **Unit (vitest):**
  - `core/scoring.ts` — every heuristic against fixture responses.
  - `core/accuracy/*` — generator prompt shape, verifier parsing, score math, edge cases (all-null, empty scrape).
  - `seo/signals/*` — each signal against fixture HTML documents.
  - `scraper/extractors.ts` — each extractor.
  - `auth/magic.ts` — token issue/verify/expiry/reuse.
  - `billing/*` — Stripe event signature, idempotency.
  - `queue/workers/*` — happy path + failure-flag propagation (providers mocked).
- **Integration (vitest + testcontainers):**
  - End-to-end grade run against mocked providers, real Postgres, real Redis. Asserts probes/grade/scrape rows written and Redis events published.
  - Rate limit over rolling 24h — time-mocked via Redis' own time commands.
- **E2E (Playwright):**
  - Paste URL on landing, see live grade complete, see paywall prompt, complete Stripe Checkout (test mode), receive report URL, render PDF.

Target: ~85% line coverage on `src/core`, `src/seo`, `src/scraper`, `src/auth`, `src/billing`.

---

## 13. Observability, ops, secrets

- **Logs:** structured JSON via pino. Correlation ID = `gradeId` flows through web → queue → worker.
- **Metrics:** BullMQ's built-in Prometheus exporter (optional), or a `/healthz` plus manual dashboards in Railway. Defer real APM.
- **Secrets:** Railway environment variables. Required: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`, `STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`, `COOKIE_HMAC_KEY`, `MAGIC_TOKEN_HMAC_KEY`, `REPORT_TOKEN_HMAC_KEY`, `RESEND_API_KEY` (or Postmark equivalent).
- **Cost controls:** daily job counts a running sum of `probes.metadata.usage` tokens; hits a soft cap → disables the free tier for that day via a feature flag.

---

## 14. Implementation plans

This spec decomposes into the following implementation plans (to be written as sibling docs under `v3/docs/superpowers/plans/`):

1. **Plan 1 — Foundation**: v3/ package scaffolding, Drizzle schema, Postgres migrations, Redis wiring, BullMQ producer/worker skeleton, `/healthz`, CI.
2. **Plan 2 — Scraper**: `scraper/` module with static fetch + Playwright fallback + all extractors + fixture-based tests. Library-only; no Hono routes.
3. **Plan 3 — SEO evaluator**: `seo/signals/*` with the 10 checks + composite scorer. Fixture tests. Library-only; no Hono routes. *(Reordered ahead of the scoring engine post-Plan-1: SEO is the smallest consumer of scrape output, validates the scrape contract cheaply, and gives a shippable end-to-end demo — paste URL → scorecard — before we commit to LLM engineering.)*
4. **Plan 4 — Scoring engine (core seeded from v1)**: port + adapt providers, prompts, judge, scoring, types. Add the new `accuracy/` submodule (generator + verifier). Library-only; no Hono routes (does make outbound HTTP to LLM providers).
5. **Plan 5 — Grade pipeline worker**: wire scraper + core engine + SEO + judge into `queue/workers/run-grade.ts`. Pub/sub progress events. Free vs paid tier branching.
6. **Plan 6 — Web service (scoring UX)**: Hono app, rate-limit middleware with rolling 24h Redis sorted set, `POST /grades`, SSE endpoint, React landing + live-grade pages. End-to-end free grade works.
7. **Plan 7 — Auth (magic link)**: email issuance + verification + session cookie + email-tier quota lift.
8. **Plan 8 — Paywall + Stripe**: checkout session, webhook, `generate-report` worker that finishes the 4-provider matrix and runs the recommendation LLM.
9. **Plan 9 — Report rendering**: React SSR template, signed-URL route, Playwright PDF worker.
10. **Plan 10 — Deploy**: Railway services, Postgres + Redis add-ons, env-var provisioning, Stripe webhook registration, DNS, Turnstile-ready stub.

Each plan is independently shippable enough to keep the main branch deployable at every step (even if earlier ones hide the paywall behind a flag until later ones land).

---

## 15. Open questions for implementation-time

- **Email provider:** Resend vs Postmark. Pick at implementation of Plan 7 based on deliverability and cost for low volume.
- **Judge model for Coverage/Accuracy verifier:** default to a mid-tier Sonnet/4o-class model. Benchmark quality during Plan 4 (scoring engine) against a sample set.
- **Landing-page proof section:** which 3 sample grades to showcase. TBD; keep the landing template data-driven so swapping is cheap.
- **Refund UX:** MVP keeps refunded reports accessible. Revisit after first month of real payments.
- **Abuse backstop:** hold off on Turnstile/hCaptcha until there's observed abuse; stub the middleware seam so adding it later is a config change.
