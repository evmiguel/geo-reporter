# GEO Reporter — Plan 9 (report rendering: HTML + PDF) design

> Sub-spec for Plan 9. Expands master spec §3.6, §8 (7-section report structure), §10 (API surface rows for `/report/*`). Brainstormed 2026-04-19. Plan 9 ships the paid deliverable: a server-rendered HTML report plus a Playwright-generated PDF, both gated by the per-report capability token persisted in Plan 8.

## 1. Scope

When Plan 8's `generate-report` worker finishes and flips `tier='paid'`, the user has a `reports` row with a 64-char hex `token` but no way to view the report. Plan 9 adds two public routes — `GET /report/:id?t=<token>` (HTML) and `GET /report/:id.pdf?t=<token>` (PDF) — plus a `render-pdf` BullMQ worker that generates the PDF eagerly on the heels of `generate-report`. Report data is assembled in the route handler by joining `grades + probes + recommendations + scrapes`, then passed as a resolved `ReportInput` into a pure React SSR `renderReport()` — no DB calls inside React components. PDF bytes are stored in a new `report_pdfs` table (Postgres BYTEA). LiveGradePage's "View your report →" placeholder link gets swapped to the real route.

**In scope**

- `GET /report/:id` — HTML route. Validates token, renders via React SSR + inlined CSS, returns complete standalone document.
- `GET /report/:id.pdf` — PDF route. Serves cached bytes from `report_pdfs` or returns 202 + status JSON if still pending.
- `GET /report/:id/status` — small JSON endpoint used by the frontend to know when PDF is ready.
- `render-pdf` BullMQ worker — reuses the scraper browser pool, calls `renderReport()` to get HTML, writes PDF bytes via `page.setContent` + `page.pdf`.
- `render-pdf` enqueue site — `generate-report` worker chains a `render-pdf` job on success (eager model).
- `src/report/` module — React components (one per section), `render.ts` orchestrator, `report.css`, `token.ts` validator.
- `report_pdfs` table + migration — one row per report with `status` enum (`pending` / `ready` / `failed`) and `bytes BYTEA NULL`.
- Model ID snapshot — write `metadata.model` into every `probes` row at probe creation time (modifies `run-grade` + `generate-report` probe writers) so the report's methodology section renders the exact model ID used at grade time even after defaults change.
- LiveGradePage update: real report route, extended PaidReportStatus to surface PDF status.

**Out of scope**

- Email delivery of the PDF — needs real Mailer (Plan 10).
- S3/R2 object storage — Postgres BYTEA handles the scale we expect (reports ~500KB–2MB). Migration path noted in production-checklist.
- A11y audit beyond SSR baseline.
- Print-quality tuning past "sections don't overflow pages badly."
- Pixel-regression testing of PDFs.
- A SPA wrapper around the SSR report (we link straight to the SSR HTML).
- `/my/reports` listing for returning users.
- Sharing / public-read toggle (reports are single-URL-secret only).

## 2. Decisions locked in on 2026-04-19

| # | Decision | Choice | Why |
|---|---|---|---|
| P9-1 | Overall aesthetic | Hybrid — cream `#fafaf7` background, Inter sans-serif body, JetBrains Mono for letter grade + numbers, `#ff7a1a` orange brand accent | Readable on screen, prints cleanly, keeps the brand without forcing the SPA's terminal aesthetic on paying users. |
| P9-2 | Report structure | Single scrolling HTML document with a table of contents at top | One URL, linkable anchors, Ctrl-F works. PDF inherits the same structure with natural page breaks. |
| P9-3 | CSS strategy | Dedicated standalone `report.css`, inlined into the `<style>` tag at render time | Report is independent of the SPA; no Tailwind build coupling; PDF renderer doesn't need to fetch external stylesheets. |
| P9-4 | Scorecard tile | Weight % + score bar variant | Shows why each category matters. Higher info density. Distinctive vs. competitor tools. |
| P9-5 | Recommendation card | Side-by-side with priority rail (numeric priority + impact/effort bars) | Dashboard feel matches the rest of the report; priority number makes sort order legible at a glance. |
| P9-6 | Raw LLM responses | Grouped by probe (question → 4 providers side-by-side) | The product's whole thesis is "do LLMs agree about you?" — comparison is the insight. Collapsible per-probe in HTML; expanded in PDF. |
| P9-7 | Accuracy appendix | Forensic table with a tinted "truth" row at top, then one row per LLM with answer + ruling | Dense + scannable. Reads like evidence. |
| P9-8 | SEO findings | Vertical checklist with per-signal detail and highlighted fail rows | Prose on failures explains *why* it matters, which the compact grid can't. |
| P9-9 | PDF storage | Postgres `report_pdfs.bytes BYTEA` | Zero new infra. Reports are small (~500KB–2MB). Backed up with the DB. S3/R2 migration is a non-blocking Plan 10 item. |
| P9-10 | PDF trigger | Eager — `generate-report` chains `render-pdf` on success | User just paid and is on the status page; by the time they click "Download PDF" it's there. Lazy model would always make first click slow. |
| P9-11 | Token validation | 64-char hex, `crypto.timingSafeEqual` on equal-length buffers, 404 on any failure (including length mismatch) | Standard capability-URL hardening. 404 (not 403) avoids leaking existence of report IDs. |
| P9-12 | Token logging | Strip `?t=...` from access logs before emit | URL logs ingest tokens; downstream log pipelines / leaks would expose capability. |
| P9-13 | Frontend integration | Direct `<a>` link to `/report/:id?t=...` — no SPA wrapper | SSR HTML is the product. Save/print/share a clean URL. "Download PDF" is a plain anchor at the top of the SSR output. |
| P9-14 | Model ID sourcing | Snapshot each provider's model ID into `probes.metadata.model` at probe creation; methodology section aggregates distinct `(provider, model)` pairs from the grade's probes | Historical accuracy: an old report saying "graded by gemini-2.5-flash" stays truthful even after we upgrade defaults. Uses existing jsonb column — no schema change. |
| P9-15 | Model display | Friendly names in the prose ("Claude Sonnet 4.6"), exact model ID in small gray text beside them | Readable for the customer, precise for the technically curious. Tiny lookup table in `src/report/model-names.ts`. |
| P9-16 | Caching headers | HTML `private, max-age=300`; PDF `private, max-age=3600, immutable` | Grades can be re-run (HTML stable but worth refreshing); PDF bytes per-ID never change. |

## 3. Architecture

```
src/report/
├── render.ts                           NEW — renderReport(input) → full HTML document string. Orchestrates section components, inlines report.css.
├── report.css                          NEW — standalone CSS for the report. Read at module init; inlined at render time.
├── token.ts                            NEW — validateToken(given, stored) → boolean. crypto.timingSafeEqual with length-match guard.
├── model-names.ts                      NEW — { "claude-sonnet-4-6": "Claude Sonnet 4.6", ... }. Single export.
├── build-input.ts                      NEW — buildReportInput({ grade, scrape, probes, recommendations }) → ReportInput. Pure transformation: groups probes by category, extracts accuracy truth excerpts from scrape, aggregates model IDs, etc.
├── types.ts                            NEW — ReportInput shape: { grade, scorecard, rawResponsesByProbe, accuracyProbes, seoFindings, recommendations, models }.
├── components/
│   ├── Layout.tsx                      NEW — <html>/<head>/<body> shell with inlined CSS and TOC skeleton.
│   ├── Cover.tsx                       NEW — Section 1: domain + letter grade + overall score + timestamp.
│   ├── Toc.tsx                         NEW — Anchor links to each section.
│   ├── Scorecard.tsx                   NEW — Section 2: 6 category tiles (weight + bar variant).
│   ├── RawResponses.tsx                NEW — Section 3: per-probe 4-provider comparison. Collapsible via <details> for HTML; open-by-default for PDF.
│   ├── AccuracyAppendix.tsx            NEW — Section 4: per-probe forensic table with truth row.
│   ├── SeoFindings.tsx                 NEW — Section 5: checklist with per-signal detail.
│   ├── Recommendations.tsx             NEW — Section 6: priority cards with numeric priority + impact/effort bars.
│   └── Methodology.tsx                 NEW — Section 7: category weights, accuracy pipeline, model IDs (snapshot), caveats, report metadata.
└── pdf/
    ├── queue.ts                        NEW — BullMQ render-pdf queue name + enqueue helper (sanitized jobId pattern: `render-pdf-${reportId}`).
    ├── deps.ts                         NEW — RenderPdfDeps interface (store, browserPool).
    └── worker.ts                       NEW — registerRenderPdfWorker. Processor: load report → renderReport() → page.setContent → page.pdf → store.writeReportPdf.

src/server/
├── app.ts                              MODIFY — mount /report sub-app (no cookie auth; token is authority).
├── deps.ts                             MODIFY — add reportStore ops to ServerDeps (or reuse GradeStore + new methods).
├── server.ts                           MODIFY — no changes if using GradeStore extension; ensure logger redacts ?t=.
└── routes/
    └── report.ts                       NEW — GET /report/:id, GET /report/:id.pdf, GET /report/:id/status.

src/store/
├── types.ts                            MODIFY — extend GradeStore: getReportById(id) → joined record (report + grade + scrape + probes + recommendations), getReportPdf, writeReportPdf, setReportPdfStatus, initReportPdfRow.
└── postgres.ts                         MODIFY — implementations. getReportById uses one transaction with 4 selects (reports, grades, scrapes, probes, recommendations).

src/db/
├── schema.ts                           MODIFY — add reportPdfs table (id UUID PK = reports.id FK, status enum, bytes bytea null, error_message text null, updated_at).
└── migrations/                         GENERATED — `pnpm db:generate` after schema edit.

src/queue/
├── queues.ts                           MODIFY — add renderPdfQueueName + getRenderPdfQueue + enqueueRenderPdf. sanitize jobId (no `:`).
└── workers/generate-report/
    └── generate-report.ts              MODIFY — after reports row written and tier='paid', call enqueueRenderPdf(reportId). On failure, log but do NOT fail the generate-report job (user still has HTML).

src/queue/workers/run-grade/categories.ts  MODIFY — every `createProbe` call adds `model: provider.model` into the metadata object. Provider gains a public `model` getter exposing the configured model ID.

src/queue/workers/generate-report/generate-report.ts  MODIFY (beyond the render-pdf enqueue): same `model` field added to paid-tier probe metadata writes.

src/llm/providers/types.ts             MODIFY — Provider interface adds `readonly model: string`.

src/llm/providers/anthropic.ts openai.ts gemini.ts perplexity.ts openrouter.ts mock.ts  MODIFY — expose `readonly model: string` (already a private field on most providers). Fallback provider returns the primary's model unmodified — see §5.4 for rationale.

src/worker/
└── index.ts                            MODIFY — register the renderPdfWorker alongside existing workers. Graceful shutdown closes browser pool (already shared with scraper).

src/web/
├── lib/
│   ├── api.ts                          MODIFY — getReportStatus(reportId, token). No postBilling-style wrapper; report URL built from grade response.
│   └── types.ts                        MODIFY — GradeResponse extended with reportId + reportToken (paid tier only). ReportStatusResponse type.
├── hooks/
│   └── usePaidReportStatus.ts          NEW — polls /report/:id/status while pdf=pending; surfaces { html, pdf } state.
├── components/
│   └── PaidReportStatus.tsx            MODIFY — accept reportId + token; use usePaidReportStatus; render "View report" + "Download PDF" links with PDF disabled-until-ready.
└── pages/
    └── LiveGradePage.tsx               MODIFY — pass reportId + reportToken into PaidReportStatus. No new routes (report opens in new tab via external-ish SSR URL).

tests/unit/report/
├── render.test.ts                      NEW — snapshot test per section component + full-report snapshot, using fixture payloads.
├── token.test.ts                       NEW — valid/invalid/length-mismatch/empty; uses timingSafeEqual stub to verify it was called.
└── model-names.test.ts                 NEW — round-trip known IDs; unknown ID falls back to raw ID.

tests/integration/
├── report-http.test.ts                 NEW — happy path, wrong token → 404, nonexistent id → 404, unpaid tier → 404, PDF pending → 202.
└── report-pdf-worker.test.ts           NEW — seed paid report → enqueue → worker writes bytes → store reflects `ready`.
```

## 4. Data model

### 4.1 New table: `report_pdfs`

```sql
CREATE TYPE report_pdf_status AS ENUM ('pending', 'ready', 'failed');

CREATE TABLE report_pdfs (
  report_id    UUID PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
  status       report_pdf_status NOT NULL DEFAULT 'pending',
  bytes        BYTEA,
  error_message TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Primary key = foreign key — one PDF per report, implicit lifecycle coupling. `bytes` is nullable because it's empty while status is `pending` or `failed`. `error_message` populated on `failed` for debugging; never surfaced to users beyond "PDF unavailable."

### 4.2 Model ID snapshot via `probes.metadata.model`

`probes.metadata` is already a freeform jsonb column used for label, latencies, token counts, etc. Plan 9 adds one more field at probe creation time: the provider's configured model ID.

```json
{
  "label": "self-gen",
  "model": "claude-sonnet-4-6",
  "latencyMs": 1240,
  ...
}
```

Written at two points (both update existing `createProbe` call sites):
- **`run-grade` worker** — every `createProbe` call in `src/queue/workers/run-grade/categories.ts` adds `model: provider.model`.
- **`generate-report` worker** — same addition in `src/queue/workers/generate-report/generate-report.ts` for the delta (Gemini + Perplexity) probes.

The methodology section aggregates distinct `(provider.id, metadata.model)` pairs from the grade's probes to list "which LLMs graded this report." Historical accuracy is automatic: probes are never updated after creation, so an old report always shows the model IDs used at that time.

**No schema migration needed for the model snapshot** — `probes.metadata` is already jsonb. This decision avoids a schema change and keeps the seam tight.

### 4.3 Store methods added to `GradeStore`

```ts
getReportById(id: string): Promise<ReportRecord | null>
getReportPdf(id: string): Promise<{ status: 'pending' | 'ready' | 'failed'; bytes: Buffer | null } | null>
initReportPdfRow(id: string): Promise<void>                 // inserts pending row, idempotent
writeReportPdf(id: string, bytes: Buffer): Promise<void>    // sets status='ready'
setReportPdfStatus(id: string, status: 'pending' | 'failed', errorMessage?: string): Promise<void>
```

`ReportRecord` is the fully-joined bundle the route handler needs:

```ts
type ReportRecord = {
  report: Report                  // reports row (id, gradeId, token, createdAt)
  grade: Grade                    // grades row (url, domain, tier, overall, letter, scores, createdAt)
  scrape: Scrape | null           // scrapes row — used for accuracy "ground truth" excerpts
  probes: Probe[]                 // all probes for the grade, ordered by createdAt
  recommendations: Recommendation[]  // ordered by rank
}
```

`getReportById` returns `null` if the report doesn't exist, if `grade.tier !== 'paid'`, or if `grade.status !== 'done'`. The route treats all three cases as 404.

## 5. Rendering pipeline

### 5.1 `renderReport(input: ReportInput): string`

Pure function. No DB access, no env access, no timestamps-from-clock. Input is fully resolved upstream. Returns a complete `<!DOCTYPE html>` document as a UTF-8 string.

Steps:
1. Call `renderToStaticMarkup(<Layout>{...sections}</Layout>)`.
2. Read `report.css` (cached at module init, not per-call).
3. Inject CSS into the Layout's `<style>` tag.
4. Prepend `<!DOCTYPE html>`.

TOC is statically declared in `<Toc />` with hardcoded anchor IDs matching each section component's wrapping `<section id="...">`. No runtime generation.

### 5.2 PDF worker processor

```
async function processRenderPdf({ reportId }) {
  const record = await store.getReportById(reportId)            // throws if missing
  const input = buildReportInput(record)                        // pure; groups probes, normalizes shapes
  const html = renderReport(input)
  const page = await browserPool.acquire()
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const bytes = await page.pdf({ format: 'Letter', printBackground: true, margin: {...} })
    await store.writeReportPdf(reportId, bytes)
  } finally {
    await browserPool.release(page)
  }
}
```

Reuses the scraper's `BrowserPool` (already long-lived in the worker process). If acquiring the browser fails (pool exhausted / container OOM), BullMQ's retry handles it.

Retry policy: 3 attempts with exponential backoff (2s, 10s, 60s). On final failure the job calls `setReportPdfStatus('failed', err.message)` and does NOT re-throw (job is marked succeeded from BullMQ's perspective, failure is a data-plane concept).

### 5.3 `generate-report` chaining

At the end of `generate-report.ts`, after the `reports` row is written and `tier='paid'` is set:

```ts
try {
  await enqueueRenderPdf(reportId)
} catch (err) {
  logger.error({ err, reportId }, 'failed to enqueue render-pdf')
  // do not fail the generate-report job — HTML works without PDF
}
```

A `report_pdfs` row with `status='pending'` is inserted at the same time the `reports` row is written, inside the same transaction, so status-checking clients never see a "ghost" state.

### 5.4 Provider `model` getter and OpenRouter fallback

To populate `metadata.model`, probe call sites read `provider.model` at the moment of probe write. The `Provider` interface gains a `readonly model: string` field. Each provider class already stores its model ID as a private field; exposing it is a one-line change per file.

The `FallbackProvider` wrapper (Plan 8's OpenRouter integration) has two possible behaviors for its `model` getter:
- **Chosen:** return the primary's model ID unmodified. Rationale: the fallback is supposed to be a transparent substitute — reporting "claude-sonnet-4-6" when OpenRouter actually served the response is arguably a lie, but per-probe detection of which path fired would require runtime state that bleeds into the wrapper's interface, and the user's mental model is "these four providers graded my site." If provider drift ever matters, we can add a `metadata.fallbackFired: boolean` field in a future iteration.
- Not chosen: exposing OpenRouter's routed model name — would require OpenRouter response introspection and leaks an implementation detail.

## 6. HTTP surface

### 6.1 `GET /report/:id?t=<token>`

1. Parse `id` as UUID — invalid → 404.
2. `store.getReportById(id)` — null → 404 (covers missing, unpaid, still-running).
3. Read `t` query param — missing → 404.
4. `validateToken(t, record.report.token)` — false → 404.
5. `buildReportInput(record)` → `renderReport(input)` → respond with `Content-Type: text/html; charset=utf-8` + `Cache-Control: private, max-age=300` + `Referrer-Policy: no-referrer` + CSP header (see §11).

### 6.2 `GET /report/:id.pdf?t=<token>`

Same steps 1–4 as HTML.
5. `store.getReportPdf(id)`:
   - `null` or `status='pending'` → 202 with JSON `{ status: 'pending' }`.
   - `status='failed'` → 503 with JSON `{ status: 'failed' }`.
   - `status='ready'` → 200 with `Content-Type: application/pdf`, `Content-Disposition: inline; filename="geo-report-<domain>.pdf"`, `Cache-Control: private, max-age=3600, immutable`, body = `bytes`.

### 6.3 `GET /report/:id/status?t=<token>`

Same steps 1–4.
5. Return JSON `{ html: 'ready', pdf: 'pending' | 'ready' | 'failed' }`. `html` is always `'ready'` (HTML is synchronous from the DB row).

### 6.4 Logger redaction

The HTTP logger (pino via Hono) gets a serializer that rewrites the request URL, replacing `?t=<anything>` with `?t=REDACTED` before emitting. Applied at the logger config site, not at the route site — catches all `/report/*` routes including future ones.

## 7. Frontend integration

### 7.1 API surface

`GET /grades/:id` response, for paid tier only, gains two fields:

```ts
reportId: string       // the reports.id UUID
reportToken: string    // the full token, so the SPA can construct the URL
```

For unpaid tiers these fields are omitted. Source of truth in `src/web/lib/types.ts`.

### 7.2 LiveGradePage

Unchanged structure. `PaidReportStatus` now receives `reportId` + `reportToken` as props (currently receives a placeholder status). The component builds the two URLs internally and polls `/report/:id/status?t=...` via `usePaidReportStatus` while pdf status is `pending`.

Visual states:
- `generating`: banner "Generating your report..." (no links).
- `html_ready_pdf_pending`: banner "Report ready." with "View report" link enabled, "Download PDF (generating...)" disabled-looking.
- `ready`: banner "Report ready." with both links enabled.
- `pdf_failed`: banner "Report ready (PDF unavailable)." with only "View report" enabled.

### 7.3 `usePaidReportStatus` hook

Polls `/report/:id/status?t=...` every 2s while `pdf === 'pending'`. Stops polling once `pdf` is `ready` or `failed`. Resolves immediately if the initial response is already `ready`. No SSE — PDF status is a simple two-state transition; polling is cheaper than adding new SSE event types to `generate-report`.

## 8. Testing strategy

### 8.1 Unit tests

- `render.test.ts`: one snapshot test per section component with a fixture payload; one full-report snapshot; one test with minimal/partial payload proving empty-state prose renders instead of crashing.
- `token.test.ts`: correct token passes; wrong token fails; short/long token fails by length; empty string fails; spy on `crypto.timingSafeEqual` to assert it's called (regression guard against a developer swapping back to `===`).
- `model-names.test.ts`: all four real model IDs round-trip to friendly names; unknown ID returns the raw ID.

### 8.2 Integration tests

- `report-http.test.ts` (testcontainers-backed):
  - Happy path: seeded paid report + valid token → 200 + HTML contains domain + overall score + "Methodology".
  - Wrong token → 404.
  - Valid token + unpaid report → 404.
  - Valid token + nonexistent id → 404.
  - PDF endpoint with `status=pending` → 202 + JSON.
  - PDF endpoint with `status=ready` → 200 + `application/pdf` + bytes match what was stored.
  - Status endpoint returns `{ html: 'ready', pdf: 'pending' }` → `{ html: 'ready', pdf: 'ready' }` after worker completes.
- `report-pdf-worker.test.ts`: seed paid report → enqueue `render-pdf` → wait for job completion → assert `report_pdfs.status='ready'` and `bytes` is non-empty; extract text via `pdf-parse` and assert domain + "Methodology" appear.

### 8.3 Fixtures

One "golden" paid-report fixture in `tests/fixtures/report.ts` exporting both a `ReportRecord` (for unit tests of `renderReport`) and a seed helper that writes the corresponding grade + scrape + probes + recommendations + reports rows to a testcontainer Postgres (for integration tests).

## 9. Error handling

| Scenario | Behavior |
|---|---|
| Unknown id | 404 |
| Valid id, unpaid tier | 404 |
| Missing `?t=` | 404 |
| Wrong-length token | 404 (length check before `timingSafeEqual`) |
| Correct-length wrong token | 404 |
| PDF pending at first request | 202 + `{ status: 'pending' }` |
| PDF worker fails all retries | row status = `failed`; PDF endpoint returns 503; HTML still works; LiveGradePage shows "PDF unavailable" |
| `generate-report` completes but enqueue-render-pdf throws | `generate-report` still succeeds; `report_pdfs` row stuck at `pending`; manual requeue possible via admin tooling (deferred) — goes on production-checklist |
| A probe row for a category is missing (e.g., no accuracy probes ran for this grade) | `buildReportInput` returns empty arrays for that section; component renders "not available in this run" prose rather than throwing |
| Render fails inside `renderToStaticMarkup` | Route returns 500; logs include reportId and stack; Sentry-equivalent (production-checklist) picks it up |

## 10. Performance & footprints

- Typical report HTML: ~80KB after inlined CSS (Gzip to ~15KB). Rendered synchronously in the request path; no network I/O during render.
- Typical PDF: 500KB–1.5MB depending on probe count. Stored in Postgres BYTEA — fine up to ~100MB rows in practice.
- `renderReport` latency: <50ms for typical input (pure React SSR, no awaits).
- PDF generation: 3–8s per report (dominated by Playwright `setContent` + `pdf`).
- Browser pool: reuses scraper's existing pool (max 2 concurrent in worker process). `render-pdf` worker concurrency set to 1 so it can't starve scraper jobs.

## 11. Security considerations

- **Token compare**: `crypto.timingSafeEqual` on equal-length buffers. Length mismatch short-circuits to 404 before buffer alloc.
- **404 over 403**: all auth failures return 404 to avoid leaking report existence.
- **Log redaction**: centralized URL-sanitizer in the logger serializer strips `?t=…`. Applies to access logs, error logs, any structured log that includes `req.url`.
- **No hot-linking of internal URLs**: report HTML has `Referrer-Policy: no-referrer` so the token isn't leaked via `Referer` headers when users click outbound links from the report.
- **Content-Disposition**: PDF served as `inline` (open-in-tab) rather than `attachment` (force-download); filename sanitized against the grade URL's host.
- **CSP**: report HTML has `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; font-src data:` — no external resources, no scripts at all. Hardens against XSS if user-controlled content somehow sneaks through payload.

## 12. Deferred / production-checklist items

- Migrate PDF storage from Postgres BYTEA to S3/R2 when reports exceed ~5MB or DB backups get noticeably larger.
- Admin endpoint to requeue `render-pdf` jobs for reports stuck in `pending` (rare; manual DB update is acceptable at MVP volume).
- A11y audit on the report HTML.
- Print-quality polish (explicit `page-break-inside: avoid` on cards, custom page headers/footers).
- Email delivery of the PDF when report is ready (Plan 10 with real Mailer).
- Pixel-regression testing.
- Rate limit on `/report/*` (token is capability, but brute-force over 2^256 is infeasible; still worth a cheap limit to cap accidental traffic).

## 13. Handoff to Plan 10

Plan 10 (deploy) needs to verify: browser pool launches successfully in the Railway container with the worker's memory budget; Postgres has enough headroom for BYTEA storage growth; access logs actually redact tokens end-to-end in production log aggregation; `generate-report` → `render-pdf` chain works in the real queue with real Playwright.

No env vars added by Plan 9. All needed config (`DATABASE_URL`, `REDIS_URL`) already set by prior plans.
