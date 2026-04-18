# geo-grader-v3

A public, paywalled web app that grades websites on how well LLMs know them. Successor to the local-only v1 CLI (`geo-grader`); v3 runs hosted with a paywall, a scrape-grounded accuracy check, and a PDF/HTML report with LLM-generated recommendations.

v1 lives at `~/repos/geo-grader/` (local-only, not a dependency). v3 seeded its initial code ideas from v1's `src/core/` during Plan 1, then evolved independently.

## Design docs (read before suggesting changes)

- Spec: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` — 17 locked-in decisions; §3 is the source of truth for anything architectural.
- Plans: `docs/superpowers/plans/` — Plan 1 (Foundation) is complete; Plans 2–10 pending.

## Architecture (one paragraph)

Two Node processes from one repo: `web` (Hono HTTP + SSE, reads/writes Postgres + Redis) and `worker` (BullMQ, runs Playwright + LLM probes + judge). Postgres via Drizzle ORM; Redis for BullMQ queues + pub/sub. Deploy target: Railway-class long-running host. Free tier: 3 grades per (IP+cookie) per rolling 24h; email gate for +10; $19 Stripe one-off unlocks the full report.

## Six scoring categories

Discoverability (30%), Recognition (20%), Accuracy (20%), Coverage (10%), Citation (10%), SEO (10%). Accuracy is the novel flow: scrape the site → generator LLM writes a site-specific question → target LLMs answer blind → verifier LLM compares against the scrape.

## Stack

Node 20, TypeScript 5.6+, Hono 4, Drizzle 0.33 + postgres-js, BullMQ 5, ioredis 5, Vitest 2 + testcontainers 10, tsup, pnpm 9. Strict TS profile: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `allowImportingTsExtensions: true` + `noEmit: true` (tsc only type-checks; tsup bundles; tsx runs dev). **Always use `.ts` extensions in imports.**

## Commands

```
pnpm dev:server         # Hono with tsx watch
pnpm dev:worker         # BullMQ worker with tsx watch
pnpm test               # unit tests only (tests/unit/**)
pnpm test:integration   # testcontainers-backed integration (tests/integration/**)
pnpm typecheck          # tsc --noEmit
pnpm build              # tsup → dist/server.js + dist/worker.js
pnpm db:generate        # regenerate migration after schema edits
pnpm db:migrate         # apply migrations to $DATABASE_URL
```

Local dev: `docker compose up -d` for Postgres (:54320) + Redis (:63790). Integration tests use testcontainers, not compose — the Docker daemon is the only hard dependency.

## Conventions

- **Git commits:** inline identity only, never touch global config:
  ```
  git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit ...
  ```
- **File responsibility:** each file has one job. Scraper, core engine, SEO signals, report generation live in separate modules that don't cross-import.
- **Test discipline:** TDD for anything with logic; integration tests hit real Postgres + Redis via testcontainers (not mocks). Integration suite is excluded from `pnpm test` via `vitest.config.ts` (include `tests/unit/**`) and included via `vitest.integration.config.ts` (60s timeouts, threads pool with `singleThread: true` so testcontainers lifecycle doesn't interleave across files).
- **Store seam:** all DB access goes through `GradeStore` (`src/store/types.ts`). `PostgresStore` is the only implementation; do not `import { db }` directly from feature code — keeps the seam swappable.

## Footguns from Plan 1 execution

- **Lazy env Proxy** (`src/config/env.ts`): `env` is a Proxy that parses `process.env` on first property access — required because vitest imports modules before test env is set. Only `get` is proxied; `Object.keys(env)`, `{...env}`, `JSON.stringify(env)`, and `'KEY' in env` all return empty. Use `loadEnv()` directly if you need the full object. Do not revert to eager.
- **Connection shutdown:** both entrypoints call `redis.quit()` AND `closeDb()` on SIGTERM/SIGINT. If you add a new long-lived resource, add its shutdown too.
- **Testcontainers flake:** occasional first-run race where BullMQ Redis connects before the container's Redis is fully ready (`ECONNREFUSED` then retry). Environmental; re-run. If it bites CI, relax `enableReadyCheck: false` in test harness only, never in prod.
- **`verbatimModuleSyntax: true`** — all type-only imports must use `import type`. Drizzle's `InferSelectModel` / `InferInsertModel` are types and MUST come in via `import type`.

## What's NOT here yet (planned, not implemented)

No LLM providers, no scraper, no SEO evaluator, no scoring engine, no `POST /grades`, no SSE, no rate limit, no auth, no Stripe, no frontend. Just the foundation: schema, queues, healthz, worker skeleton, CI. All of that lands in Plans 2–10.

## Plan execution mode

Use the Superpowers skill chain: `brainstorming` → `writing-plans` → `subagent-driven-development` (fresh subagent per task, spec + quality reviewers between tasks). The worktree pattern (`.worktrees/`) is the default for isolation.
