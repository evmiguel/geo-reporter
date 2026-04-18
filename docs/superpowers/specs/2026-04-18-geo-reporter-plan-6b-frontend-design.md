# GEO Reporter — Plan 6b (React frontend) design

> Sub-spec for Plan 6b. Expands master spec §11 (Frontend). Plan 6 was split into 6a (backend, shipped 2026-04-18) + 6b (frontend, this spec) during the 2026-04-18 brainstorm. Plan 6a is merged at `156391d`.

## 1. Scope

Plan 6b adds the React terminal-aesthetic frontend: three user-facing pages (landing, live grade, email gate) plus a 404 fallback. Vite builds to `dist/web/`; the Hono server ships `serveStatic` to serve it in production. In development, Vite runs separately and proxies API/SSE calls to Hono.

Eleven decisions locked in during brainstorming. Design-level visuals approved via browser mockups (layout shell: sidebar-less; LiveGrade: tiles + log).

**In Plan 6b:** Landing, LiveGrade, EmailGate (stub, Plan 7 wires the verify flow), NotFound, Vite + Tailwind v4 setup with v1's color tokens.

**NOT in Plan 6b:** `/report/:id` (Plan 9), `/my/grades` (Plan 7), `/settings` (post-MVP), Stripe checkout action (Plan 8), Playwright E2E (Plan 10).

## 2. Decisions locked in on 2026-04-18

| # | Decision | Choice | Why |
|---|---|---|---|
| P6b-0 | Plan split | Plan 6 was split into 6a (HTTP surface, done) + 6b (this, frontend) | 30-task combined plan too big to ship safely; Plan 6a's HTTP is curl-testable standalone. |
| P6b-1 | Routes | `/`, `/g/:id`, `/email`, `*` (404 fallback) | Minimum user journey; Plans 7/9/post-MVP add the rest. 404 fallback prevents blank screens on typos. |
| P6b-2 | Layout shell | Sidebar-less single column with a minimal top header | Only 3 pages in MVP — a sidebar is inventory for rooms not yet built. Plan 7's `/my/grades` earns the sidebar. |
| P6b-3 | LiveGrade layout | 2×3 category tile grid at the top + chronological probe log below | Tiles provide glanceable summary and orient the user toward the final scorecard. Log provides the "alive" texture that 60–90s of waiting demands. Accordion and pure-log alternatives rejected — both sacrifice one of those two goals. |
| P6b-4 | Source layout | `src/web/` frontend source, `dist/web/` build output, two-terminal dev (Vite on :5173 proxying to Hono on :7777), `serveStatic` same-origin in prod | Matches master spec §4.2, keeps Plan 6a backend architecture untouched, Vite HMR works natively. CDN deploy (cross-subdomain cookies) is on the production checklist. |
| P6b-5 | SSE client | Native `EventSource` with `withCredentials: true` | ~20-line hook wrapper; cookie auth is all we need. Custom-header needs (Plan 9 signed tokens) live on non-SSE routes. |
| P6b-6 | Data fetching | Plain `fetch` + React hooks | Three pages, four endpoints, no caching story to manage. TanStack Query would be 5× the integration cost of its value. |
| P6b-7 | Routing | React Router v6 | Industry standard, ~15KB, minimal learning curve. Plans 7/9 will add routes without a library swap. |
| P6b-8 | Testing | Vitest + React Testing Library + happy-dom; no Playwright | Playwright's value unlocks at Stripe/report scope (Plan 10). RTL catches the page-rendering and SSE-consumer bugs that matter for Plan 6b. |
| P6b-9 | State management | Pure `reduceGradeEvents(state, event)` + thin `useGradeEvents(gradeId)` hook | Separates logic from React the same way Plans 4/5 separate flows from orchestration. Reducer is unit-tested as a pure function; hook is trivial React plumbing. |
| P6b-10 | Visual tokens | Tailwind v4 `@theme` block ported from v1 — same color palette (`#0a0a0a` bg, `#ff7a1a` brand, `#5cf28e` good, etc.) and JetBrains Mono font stack | Preserves the aesthetic decision from master spec §3 #17 — "inherit v1's terminal aesthetic, already validated." |

## 3. Architecture

```
src/web/                               NEW — frontend source
├── index.html                           Vite entry HTML
├── main.tsx                             ReactDOM.createRoot + Router
├── App.tsx                              route layout (<Header/> + <Outlet/>)
├── styles.css                           Tailwind v4 import + @theme block
├── vite-env.d.ts                        Vite ambient types
├── pages/
│   ├── LandingPage.tsx                  `/` — hero + URL form → POST /grades → navigate
│   ├── LiveGradePage.tsx                `/g/:id` — SSE consumer + scorecard + log
│   ├── EmailGatePage.tsx                `/email` — placeholder, Plan 7 wires
│   └── NotFoundPage.tsx                 `*` — 404 fallback
├── components/
│   ├── Header.tsx                       persistent top bar
│   ├── CategoryTile.tsx                 one tile in the 2×3 grid
│   ├── ProbeLogRow.tsx                  one row of the chronological log
│   ├── GradeLetter.tsx                  big letter display (done state)
│   ├── StatusBar.tsx                    phase indicator
│   └── UrlForm.tsx                      URL input + submit (used on Landing)
├── hooks/
│   ├── useGradeEvents.ts                EventSource → reducer → state
│   └── useCreateGrade.ts                POST /grades mutation
└── lib/
    ├── api.ts                           typed fetch wrappers
    ├── grade-reducer.ts                 pure reduceGradeEvents
    └── types.ts                         GradeEvent mirror + frontend state types

vite.config.ts                         NEW — repo root; proxy + build config
tsconfig.web.json                      NEW — frontend tsconfig (JSX + DOM libs)

src/server/app.ts                      MODIFY — add serveStatic catch-all for built assets (prod only)

package.json                           MODIFY — add React + Vite + Tailwind devDeps; new scripts

tsconfig.json                          MODIFY — exclude src/web/** from the root build (has its own tsconfig)

README.md                              MODIFY — "Running the React dev loop" section

tests/unit/web/
├── grade-reducer.test.ts              ~10 pure-reducer tests
└── components/                         ~5-6 RTL component tests
    ├── CategoryTile.test.tsx
    ├── ProbeLogRow.test.tsx
    ├── StatusBar.test.tsx
    ├── UrlForm.test.tsx
    └── LiveGradePage.test.tsx         one component-integration test stubbing useGradeEvents

vitest.config.ts                       MODIFY — environment: 'happy-dom' for tests/unit/web/**
```

### Dev workflow

```
Terminal 1: pnpm dev:server      # Hono API on :7777
Terminal 2: pnpm dev:web         # Vite on :5173 with HMR, proxies /grades/* and /healthz to :7777
Browser:    http://localhost:5173
```

### Production workflow

```
pnpm build                       # runs tsup + vite build in sequence
node dist/server.js              # Hono serves API + serveStatic('/') over dist/web
```

`buildApp` in Plan 6a gains a catch-all `serveStatic` that:
- Serves `dist/web/assets/*` directly.
- Falls back to `dist/web/index.html` for any unmatched GET (so React Router handles `/g/:id`, `/email`, etc. on page refresh).
- Skips `/healthz` and `/grades/*` (those routes mount before the catch-all).

### Module boundary invariants

- `src/web/**` imports nothing from `src/server/`, `src/worker/`, `src/store/`, `src/db/`, `src/queue/`, `src/scraper/`, `src/llm/`, `src/scoring/`, or `src/accuracy/`.
- Shared types (`GradeEvent`, `CategoryId`, `ProviderId`) are duplicated into `src/web/lib/types.ts`. The backend's `src/queue/events.ts` remains authoritative; any drift is caught at the API-response parse site.
- Frontend unit tests run in `happy-dom` via a vitest environment override scoped to `tests/unit/web/**`. Backend tests continue running in Node environment unchanged.

## 4. The grade reducer

`src/web/lib/grade-reducer.ts` — pure function, no React, no DOM. Full signature + types in the Section 2 design doc; summary:

```ts
export function initialGradeState(): GradeState
export function reduceGradeEvents(state: GradeState, event: GradeEvent, now: number): GradeState
```

`GradeState` includes `phase`, a `Map<string, ProbeEntry>` keyed by `category:provider:label`, `categoryScores`, `overall`, `letter`, and `error`. The `Map` makes writes idempotent — `probe.completed` replaces any prior entry for the same key, so hydrated replay on SSE reconnect is safe against duplicate events.

Testable as pure function. ~10 tests cover: each event type's state transition, idempotent duplicates, hydrated-replay ordering (completed before started), full-lifecycle sequence producing correct end state.

## 5. Pages and components

### Pages

**`LandingPage.tsx`** — `/`. Hero h1 + subhead + `<UrlForm />`. On submit: `useCreateGrade()` posts to `/grades`. On `202` → navigate to `/g/<gradeId>`. On `429` → navigate to `/email?retry=<seconds>` (reads `retryAfter` from response body). On `400` (URL validation) → inline error on the form. ~40 lines.

**`LiveGradePage.tsx`** — `/g/:id`. `useParams()` for id; `useGradeEvents(id)` for state.
- Heading with URL and phase (via `<StatusBar />`).
- 2×3 grid of `<CategoryTile />` — one per CategoryId. Score, weight, color by threshold.
- Chronological probe log below — `state.probes.values()` sorted by `startedAt`, rendered as `<ProbeLogRow />`s.
- When `phase === 'done'`: `<GradeLetter />` above the tiles (replaces StatusBar); footer CTA "Get the full report — $19" (dead link; Plan 8 wires).
- When `phase === 'failed'`: tiles + log replaced with error panel + "Try again" link back to `/`.
- ~80 lines.

**`EmailGatePage.tsx`** — `/email`. Reads `?retry=<seconds>` for countdown display. Email input + submit → POST `/auth/magic`. Plan 7 wires that route; until then, 404 response shows "Coming soon." Back-to-home link. ~35 lines.

**`NotFoundPage.tsx`** — `*`. Terminal-style 404 message + link to `/`. ~15 lines.

### Components

| Component | Responsibility | Line budget |
|---|---|---|
| `Header.tsx` | Top bar — logo + minimal nav | ~20 |
| `UrlForm.tsx` | Controlled input + submit button; client-side empty/URL-shape check | ~30 |
| `StatusBar.tsx` | Phase dots: queued → running → scraped → done | ~25 |
| `CategoryTile.tsx` | One tile: name, weight, score (dim when null, colored by threshold) | ~25 |
| `ProbeLogRow.tsx` | `[elapsed-s] ✓\|▶ category/provider/label · score` | ~20 |
| `GradeLetter.tsx` | Big letter grade + overall number (done state) | ~25 |

### Hooks

**`useGradeEvents.ts`** — wraps `EventSource` + reducer. Opens `/grades/:id/events` with `withCredentials: true`, dispatches each parsed message through `reduceGradeEvents`, closes on unmount. No explicit reconnect logic; EventSource auto-reconnects, and Plan 6a's server-side always-hydrate handles catch-up.

**`useCreateGrade.ts`** — posts to `/grades`, handles 202 / 400 / 429 branching. Returns `{ create, pending, error }`.

## 6. Styling

`src/web/styles.css`:

```css
@import "tailwindcss";

@theme {
  --color-bg: #0a0a0a;
  --color-bg-elevated: #0f0f0f;
  --color-bg-sidebar: #070707;
  --color-fg: #e8e8e8;
  --color-fg-dim: #9a9a9a;
  --color-fg-muted: #6e6e6e;
  --color-fg-faint: #3a3a3a;
  --color-line: #1f1f1f;
  --color-brand: #ff7a1a;
  --color-brand-dim: #b85a14;
  --color-good: #5cf28e;
  --color-good-dim: #3da45e;
  --color-warn: #f5b94a;

  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --font-display: "JetBrains Mono", ui-monospace, monospace;
}
```

Ported verbatim from v1's `src/web/styles.css`. Plus a handful of global resets matching v1 (body font, box-sizing, scrollbar, selection color).

Components use Tailwind utility classes referencing these custom tokens: `bg-[var(--color-bg)]`, `text-[var(--color-brand)]`, etc. No Tailwind theme extension file — v4's `@theme` block is the single source of tokens.

## 7. Testing

### Unit (Vitest + RTL + happy-dom)

- `tests/unit/web/grade-reducer.test.ts` — ~10 tests. Each event type, idempotence, hydrated-replay ordering, full-lifecycle integration.
- `tests/unit/web/components/CategoryTile.test.tsx` — ~4 tests. Pending state, scored state, threshold colors, done+null "unscored" footnote.
- `tests/unit/web/components/ProbeLogRow.test.tsx` — ~3 tests. Started vs completed glyph, elapsed time display, error state.
- `tests/unit/web/components/StatusBar.test.tsx` — ~2 tests. Correct dot highlighted per phase.
- `tests/unit/web/components/UrlForm.test.tsx` — ~3 tests. Calls onSubmit with URL, renders error when passed, disabled during pending.
- `tests/unit/web/components/LiveGradePage.test.tsx` — ~2 tests. Renders tiles + log from stubbed `useGradeEvents`; renders `<GradeLetter />` when phase=done.

Target: ~16 new tests. Running total: 286 (Plan 6a) + 16 = **~302 unit tests**.

### No new integration tests, no Playwright

Plan 6a already covers the HTTP surface end-to-end via testcontainers. Plan 6b's integration is "static-serve the built frontend" — a tsup/Vite build-step concern, not a behavior test. Playwright enters at Plan 10 (deploy) once there's a Stripe/report flow worth smoke-testing end-to-end.

## 8. Out of scope

- **Stripe checkout action** — Plan 8. The `Get the full report — $19` CTA is a dead link in Plan 6b.
- **Auth flow wiring** — Plan 7. EmailGatePage submits to `/auth/magic` which 404s until then; the form shows "Coming soon" response state.
- **Report HTML/PDF** — Plan 9.
- **`/my/grades`** — Plan 7 (needs auth session).
- **`/settings`** — post-MVP.
- **Reconnect UX polish** — EventSource auto-reconnect + server-side hydration do their job; no "reconnecting…" banner or retry button in Plan 6b.
- **Keyboard shortcuts + a11y audit** — use semantic HTML + focus rings; logged to production checklist for launch prep.
- **i18n** — English only. Not on any plan.
- **Analytics, error reporting** — Plan 10.
- **Favicon + brand OG metadata** — placeholder in Plan 6b.
- **Playwright E2E** — Plan 10.

## 9. Relationship to master spec §11

Master spec §11 lists six pages: `/`, `/g/:id`, `/email`, `/report/:id`, `/my`, `/settings`. Plan 6b ships three of them (+ 404 fallback):

- `/` ✓ Landing
- `/g/:id` ✓ LiveGrade
- `/email` ✓ EmailGate (placeholder — real verify flow in Plan 7)
- `/report/:id?t=` → Plan 9
- `/my/grades` → Plan 7
- `/settings` → post-MVP

Master spec §11 also listed components "inherited in spirit from v1: `GradeLetter`, `CategoryCard`, `ProbePanel`, `Sidebar`, `Layout`." Plan 6b renames for clarity: `GradeLetter`, `CategoryTile`, `ProbeLogRow`, no sidebar (decision P6b-2), `Header`. `AdHocRepl` from v1 is out — was an authoring-mode REPL not relevant to the paywalled app.

After this spec is approved, master spec §11 should be amended with a short "Plan 6b interpretation calls" anchor pointing here.
