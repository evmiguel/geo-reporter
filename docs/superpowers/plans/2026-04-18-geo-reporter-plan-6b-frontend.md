# GEO Reporter Plan 6b — React Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Vite + React + Tailwind v4 frontend for geo-grader-v3: three pages (landing, live grade, email gate) + 404 fallback, consuming Plan 6a's HTTP + SSE surface.

**Architecture:** `src/web/` is the React app. Vite dev server on :5173 proxies API/SSE calls to Hono on :7777 in dev. `pnpm build` emits `dist/web/` which Hono serves via `serveStatic` in production. A pure `reduceGradeEvents(state, event)` reducer owns all live-grade logic; `useGradeEvents` wraps it with EventSource. Components are thin views on top of the reducer's state.

**Tech Stack:** TypeScript 5.6+ strict, React 18, React Router v6, Vite 5, Tailwind v4 (`@tailwindcss/vite`), Vitest 2 + React Testing Library + happy-dom. All new deps; nothing added to the backend bundle.

---

## Spec references

- Sub-spec (source of truth): `docs/superpowers/specs/2026-04-18-geo-reporter-plan-6b-frontend-design.md`
- Master spec: `docs/superpowers/specs/2026-04-17-geo-reporter-design.md` §11 (Frontend) — amended with Plan 6b anchor at `f1f0029`.
- Plan 6a HTTP surface already shipped: `POST /grades`, `GET /grades/:id`, `GET /grades/:id/events` SSE.

**Interpretation calls locked in (sub-spec §2, brainstormed 2026-04-18):**

- P6b-0: Plan 6a/6b split — this is 6b.
- P6b-1: Routes: `/`, `/g/:id`, `/email`, `*` (404).
- P6b-2: Sidebar-less shell.
- P6b-3: LiveGrade = 2×3 category tiles + chronological probe log.
- P6b-4: `src/web/` source, `dist/web/` output, two-terminal dev, `serveStatic` in prod.
- P6b-5: Native `EventSource` with `withCredentials: true`.
- P6b-6: Plain `fetch` + React hooks; no TanStack Query.
- P6b-7: React Router v6.
- P6b-8: Vitest + RTL + happy-dom; no Playwright.
- P6b-9: Pure `reduceGradeEvents` + thin `useGradeEvents` hook.
- P6b-10: Tailwind v4 `@theme` block ported from v1.

---

## File structure

```
src/web/                                  NEW — React frontend
├── index.html                              Vite HTML entry
├── main.tsx                                React root + BrowserRouter
├── App.tsx                                 route table + layout (<Header/> + <Outlet/>)
├── styles.css                              Tailwind + @theme with v1 tokens
├── vite-env.d.ts                           Vite ambient types
├── pages/
│   ├── LandingPage.tsx                     `/`
│   ├── LiveGradePage.tsx                   `/g/:id`
│   ├── EmailGatePage.tsx                   `/email`
│   └── NotFoundPage.tsx                    `*`
├── components/
│   ├── Header.tsx                          top bar
│   ├── UrlForm.tsx                         URL input + submit
│   ├── StatusBar.tsx                       phase dots
│   ├── CategoryTile.tsx                    one tile
│   ├── ProbeLogRow.tsx                     one log row
│   └── GradeLetter.tsx                     final letter display
├── hooks/
│   ├── useGradeEvents.ts                   EventSource → reducer → state
│   └── useCreateGrade.ts                   POST /grades mutation
└── lib/
    ├── api.ts                              typed fetch wrappers
    ├── grade-reducer.ts                    reduceGradeEvents (pure)
    └── types.ts                            GradeEvent mirror + state types

vite.config.ts                            NEW — repo root; proxy + build config
tsconfig.web.json                         NEW — frontend tsconfig (DOM + JSX libs)

src/server/app.ts                         MODIFY — add serveStatic catch-all in prod
package.json                              MODIFY — new deps + scripts
tsconfig.json                             MODIFY — exclude src/web/** from root build
vitest.config.ts                          MODIFY — happy-dom env for tests/unit/web/**
README.md                                 MODIFY — add "Running the React dev loop" section

tests/unit/web/                           NEW
├── grade-reducer.test.ts                   ~10 pure-reducer tests
└── components/
    ├── CategoryTile.test.tsx               ~4 RTL tests
    ├── ProbeLogRow.test.tsx                ~3 RTL tests
    ├── StatusBar.test.tsx                  ~2 RTL tests
    ├── UrlForm.test.tsx                    ~3 RTL tests
    └── LiveGradePage.test.tsx              ~2 component-integration tests (stub hook)
```

**Module boundaries enforced:**

- `src/web/**` imports nothing from any other `src/*` directory. Types are duplicated in `src/web/lib/types.ts` (small cost; zero-coupling benefit).
- Backend `src/server/app.ts` gains a *conditional* `serveStatic` mount that activates only when `deps.env.NODE_ENV === 'production'` — dev unaffected.
- `tsconfig.json` excludes `src/web/**`; `tsconfig.web.json` is the only frontend type-check target.

---

## Project constraints (from CLAUDE.md)

- `.ts`/`.tsx` extensions everywhere — frontend can omit `.ts` in imports if you set `moduleResolution: 'bundler'` in `tsconfig.web.json`, but use the extension for consistency with the backend convention.
- `import type` for type-only imports.
- Strict TS profile — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Inline git identity: `git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit ...`. Never touch global config.
- `pnpm` only.
- Unit tests under `tests/unit/**`; frontend tests under `tests/unit/web/**` (for vitest environment scoping).

---

## Task 1 — Scaffold Vite + React + Tailwind + "Hello" page

**Files:**
- Modify: `package.json` (new deps + scripts)
- Create: `vite.config.ts`
- Create: `tsconfig.web.json`
- Modify: `tsconfig.json` (exclude `src/web/**`)
- Create: `src/web/index.html`
- Create: `src/web/vite-env.d.ts`
- Create: `src/web/styles.css`
- Create: `src/web/main.tsx`
- Create: `src/web/App.tsx`
- Modify: `vitest.config.ts` (happy-dom env for `tests/unit/web/**`)

### Step 1: Install runtime + dev deps

Run:
```bash
pnpm add react@^18.3.1 react-dom@^18.3.1 react-router-dom@^6.26.2
pnpm add -D vite@^5.4.8 @vitejs/plugin-react@^4.3.1 \
  tailwindcss@^4.0.0 @tailwindcss/vite@^4.0.0 \
  @types/react@^18.3.3 @types/react-dom@^18.3.0 \
  happy-dom@^15.7.4 \
  @testing-library/react@^16.0.1 @testing-library/jest-dom@^6.5.0 @testing-library/user-event@^14.5.2
```
Expected: packages added to `dependencies` + `devDependencies`.

### Step 2: Add package.json scripts

Modify `package.json`'s `"scripts"` block. Add these three (keep all existing):
```json
    "dev:web": "vite",
    "web:build": "vite build",
    "web:preview": "vite preview"
```
Place them between `"dev:worker"` and `"enqueue-grade"` for grouping.

Update `"build"` to run both:
```json
    "build": "tsup && pnpm web:build",
```
Update `"typecheck"` to cover both tsconfigs:
```json
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.web.json",
```

### Step 3: Create `vite.config.ts` at repo root

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/grades': { target: 'http://localhost:7777', changeOrigin: true },
      '/healthz': { target: 'http://localhost:7777', changeOrigin: true },
    },
  },
})
```

### Step 4: Create `tsconfig.web.json` at repo root

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "useDefineForClassFields": true,
    "types": ["vite/client"]
  },
  "include": ["src/web/**/*", "tests/unit/web/**/*"]
}
```

### Step 5: Modify root `tsconfig.json` to exclude `src/web/**`

Read the existing `tsconfig.json`. Find the top-level `"exclude"` array (add it if missing). Add `"src/web/**/*"`.

If the file has no `"exclude"`, add it alongside `"include"`:
```json
{
  "include": [...existing...],
  "exclude": ["src/web/**/*", "tests/unit/web/**/*", "node_modules", "dist"]
}
```

### Step 6: Create `src/web/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>geo-reporter</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

### Step 7: Create `src/web/vite-env.d.ts`

```ts
/// <reference types="vite/client" />
```

### Step 8: Create `src/web/styles.css`

Port v1's tokens exactly. Full file:
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

html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-mono);
  font-feature-settings: "calt", "ss01";
  -webkit-font-smoothing: antialiased;
  background: var(--color-bg);
  color: var(--color-fg);
}

* { box-sizing: border-box; }

::selection {
  background: var(--color-brand);
  color: var(--color-bg);
}

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--color-bg); }
::-webkit-scrollbar-thumb { background: var(--color-line); border-radius: 0; }
::-webkit-scrollbar-thumb:hover { background: var(--color-fg-faint); }
```

### Step 9: Create `src/web/main.tsx`

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('root element not found')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
```

### Step 10: Create `src/web/App.tsx` — minimal "Hello" placeholder

```tsx
import { Routes, Route } from 'react-router-dom'

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<div className="p-8"><h1 className="text-[var(--color-brand)] text-xl">geo-reporter</h1><p className="text-[var(--color-fg-dim)] mt-2">frontend scaffold — pages coming in subsequent tasks</p></div>} />
    </Routes>
  )
}
```

### Step 11: Update `vitest.config.ts` — happy-dom for web tests

Read the existing `vitest.config.ts`. Merge in `environmentMatchGlobs`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**'],
    environmentMatchGlobs: [
      ['tests/unit/web/**', 'happy-dom'],
    ],
    // ... existing config preserved
  },
})
```
If the file already has `test: { ... }`, just add the `environmentMatchGlobs` key. Do not remove anything else.

### Step 12: Verify dev loop + typecheck

Run: `pnpm typecheck`
Expected: both the root tsc and tsc -p tsconfig.web.json pass with 0 errors.

Run: `pnpm test`
Expected: all 286 existing tests still pass (no new tests yet).

Start the dev server (manual smoke):
```bash
pnpm dev:web &
DEV_PID=$!
sleep 2
curl -sf http://localhost:5173 | grep -q 'id="root"' && echo OK || echo FAIL
kill $DEV_PID
```
Expected: `OK` printed.

### Step 13: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add package.json pnpm-lock.yaml vite.config.ts tsconfig.web.json tsconfig.json src/web/index.html src/web/vite-env.d.ts src/web/styles.css src/web/main.tsx src/web/App.tsx vitest.config.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): scaffold Vite + React + Tailwind v4 frontend under src/web"
```

---

## Task 2 — `GradeEvent` types + pure `grade-reducer`

**Files:**
- Create: `src/web/lib/types.ts`
- Create: `src/web/lib/grade-reducer.ts`
- Create: `tests/unit/web/grade-reducer.test.ts`

### Step 1: Create `src/web/lib/types.ts`

```ts
export type CategoryId =
  | 'discoverability' | 'recognition' | 'accuracy' | 'coverage' | 'citation' | 'seo'

export type ProviderId = 'claude' | 'gpt' | 'gemini' | 'perplexity' | 'mock'

export type GradeEvent =
  | { type: 'running' }
  | { type: 'scraped'; rendered: boolean; textLength: number }
  | { type: 'probe.started'; category: CategoryId; provider: ProviderId | null; label: string }
  | {
      type: 'probe.completed'
      category: CategoryId
      provider: ProviderId | null
      label: string
      score: number | null
      durationMs: number
      error: string | null
    }
  | { type: 'category.completed'; category: CategoryId; score: number | null }
  | { type: 'done'; overall: number; letter: string; scores: Record<CategoryId, number | null> }
  | { type: 'failed'; error: string }

export type Phase = 'queued' | 'running' | 'scraped' | 'done' | 'failed'

export interface ProbeEntry {
  key: string
  category: CategoryId
  provider: ProviderId | null
  label: string
  status: 'started' | 'completed'
  score: number | null
  durationMs: number
  error: string | null
  startedAt: number
}

export interface GradeState {
  phase: Phase
  scraped: { rendered: boolean; textLength: number } | null
  probes: Map<string, ProbeEntry>
  categoryScores: Record<CategoryId, number | null>
  overall: number | null
  letter: string | null
  error: string | null
}

export const CATEGORY_ORDER: CategoryId[] = [
  'discoverability', 'recognition', 'accuracy', 'coverage', 'citation', 'seo',
]

export const CATEGORY_WEIGHTS: Record<CategoryId, number> = {
  discoverability: 30, recognition: 20, accuracy: 20, coverage: 10, citation: 10, seo: 10,
}
```

### Step 2: Write failing reducer tests

Create `tests/unit/web/grade-reducer.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { initialGradeState, reduceGradeEvents } from '../../../src/web/lib/grade-reducer.ts'
import type { GradeEvent } from '../../../src/web/lib/types.ts'

const NOW = 1_700_000_000_000

describe('reduceGradeEvents', () => {
  it('initial state has phase=queued, empty probes, all categoryScores null', () => {
    const s = initialGradeState()
    expect(s.phase).toBe('queued')
    expect(s.probes.size).toBe(0)
    expect(s.categoryScores.discoverability).toBeNull()
    expect(s.overall).toBeNull()
    expect(s.error).toBeNull()
  })

  it('running event flips phase to running', () => {
    const s = reduceGradeEvents(initialGradeState(), { type: 'running' }, NOW)
    expect(s.phase).toBe('running')
  })

  it('scraped event sets phase + scraped metadata', () => {
    const s = reduceGradeEvents(initialGradeState(), { type: 'scraped', rendered: true, textLength: 1234 }, NOW)
    expect(s.phase).toBe('scraped')
    expect(s.scraped).toEqual({ rendered: true, textLength: 1234 })
  })

  it('probe.started adds a probe with status=started', () => {
    const s = reduceGradeEvents(initialGradeState(), {
      type: 'probe.started', category: 'seo', provider: null, label: 'title',
    }, NOW)
    expect(s.probes.size).toBe(1)
    const probe = s.probes.get('seo:-:title')
    expect(probe?.status).toBe('started')
    expect(probe?.startedAt).toBe(NOW)
  })

  it('probe.completed after probe.started upgrades the entry in place', () => {
    let s = initialGradeState()
    s = reduceGradeEvents(s, { type: 'probe.started', category: 'recognition', provider: 'claude', label: 'prompt_1' }, NOW)
    s = reduceGradeEvents(s, {
      type: 'probe.completed', category: 'recognition', provider: 'claude', label: 'prompt_1',
      score: 85, durationMs: 1200, error: null,
    }, NOW + 1200)
    expect(s.probes.size).toBe(1)
    const probe = s.probes.get('recognition:claude:prompt_1')
    expect(probe?.status).toBe('completed')
    expect(probe?.score).toBe(85)
    expect(probe?.durationMs).toBe(1200)
    expect(probe?.startedAt).toBe(NOW) // preserves original startedAt
  })

  it('probe.completed without prior started (hydrated replay) adds a completed entry', () => {
    const s = reduceGradeEvents(initialGradeState(), {
      type: 'probe.completed', category: 'citation', provider: 'gpt', label: 'official-url',
      score: 50, durationMs: 800, error: null,
    }, NOW)
    expect(s.probes.size).toBe(1)
    expect(s.probes.get('citation:gpt:official-url')?.status).toBe('completed')
  })

  it('duplicate probe.completed for same key is idempotent', () => {
    let s = initialGradeState()
    const event: GradeEvent = {
      type: 'probe.completed', category: 'seo', provider: null, label: 'canonical',
      score: 100, durationMs: 0, error: null,
    }
    s = reduceGradeEvents(s, event, NOW)
    s = reduceGradeEvents(s, event, NOW + 100)
    expect(s.probes.size).toBe(1)
  })

  it('category.completed updates only the named category', () => {
    let s = initialGradeState()
    s = reduceGradeEvents(s, { type: 'category.completed', category: 'seo', score: 90 }, NOW)
    expect(s.categoryScores.seo).toBe(90)
    expect(s.categoryScores.recognition).toBeNull()
    s = reduceGradeEvents(s, { type: 'category.completed', category: 'recognition', score: 75 }, NOW)
    expect(s.categoryScores.recognition).toBe(75)
    expect(s.categoryScores.seo).toBe(90)
  })

  it('done event flips phase + sets overall/letter and overwrites categoryScores', () => {
    let s = initialGradeState()
    s = reduceGradeEvents(s, { type: 'category.completed', category: 'seo', score: 90 }, NOW)
    s = reduceGradeEvents(s, {
      type: 'done', overall: 78, letter: 'C+',
      scores: { discoverability: 80, recognition: 75, accuracy: 60, coverage: 70, citation: 100, seo: 80 },
    }, NOW)
    expect(s.phase).toBe('done')
    expect(s.overall).toBe(78)
    expect(s.letter).toBe('C+')
    // done event overwrites categoryScores with the authoritative map
    expect(s.categoryScores.seo).toBe(80)
  })

  it('failed event sets phase + error', () => {
    const s = reduceGradeEvents(initialGradeState(), { type: 'failed', error: 'scrape too short' }, NOW)
    expect(s.phase).toBe('failed')
    expect(s.error).toBe('scrape too short')
  })

  it('full lifecycle: running → scraped → probes → categories → done ends in correct shape', () => {
    let s = initialGradeState()
    s = reduceGradeEvents(s, { type: 'running' }, NOW)
    s = reduceGradeEvents(s, { type: 'scraped', rendered: false, textLength: 3000 }, NOW + 100)
    const categories: Array<{ cat: GradeEvent extends { category: infer C } ? C : never, provider: 'claude' | 'gpt' | null, label: string }> = [
      { cat: 'seo' as const, provider: null, label: 'title' },
      { cat: 'recognition' as const, provider: 'claude', label: 'prompt_1' },
      { cat: 'citation' as const, provider: 'gpt', label: 'official-url' },
    ]
    for (const { cat, provider, label } of categories) {
      s = reduceGradeEvents(s, { type: 'probe.started', category: cat, provider, label }, NOW + 200)
      s = reduceGradeEvents(s, {
        type: 'probe.completed', category: cat, provider, label, score: 80, durationMs: 500, error: null,
      }, NOW + 700)
    }
    s = reduceGradeEvents(s, {
      type: 'done', overall: 80, letter: 'B-',
      scores: { discoverability: 80, recognition: 80, accuracy: 80, coverage: 80, citation: 80, seo: 80 },
    }, NOW + 1000)
    expect(s.phase).toBe('done')
    expect(s.probes.size).toBe(3)
    expect([...s.probes.values()].every((p) => p.status === 'completed')).toBe(true)
  })
})
```

### Step 3: Verify tests fail (module missing)

Run: `pnpm test tests/unit/web/grade-reducer.test.ts`
Expected: FAIL — module does not exist.

### Step 4: Implement `src/web/lib/grade-reducer.ts`

```ts
import type { GradeEvent, GradeState, CategoryId } from './types.ts'

export function initialGradeState(): GradeState {
  return {
    phase: 'queued',
    scraped: null,
    probes: new Map(),
    categoryScores: {
      discoverability: null, recognition: null, accuracy: null,
      coverage: null, citation: null, seo: null,
    },
    overall: null,
    letter: null,
    error: null,
  }
}

function probeKey(category: CategoryId, provider: string | null, label: string): string {
  return `${category}:${provider ?? '-'}:${label}`
}

export function reduceGradeEvents(state: GradeState, event: GradeEvent, now: number): GradeState {
  switch (event.type) {
    case 'running':
      return { ...state, phase: 'running' }
    case 'scraped':
      return { ...state, phase: 'scraped', scraped: { rendered: event.rendered, textLength: event.textLength } }
    case 'probe.started': {
      const key = probeKey(event.category, event.provider, event.label)
      const probes = new Map(state.probes)
      const existing = probes.get(key)
      probes.set(key, {
        key,
        category: event.category,
        provider: event.provider,
        label: event.label,
        status: 'started',
        score: null,
        durationMs: 0,
        error: null,
        startedAt: existing?.startedAt ?? now,
      })
      return { ...state, probes }
    }
    case 'probe.completed': {
      const key = probeKey(event.category, event.provider, event.label)
      const probes = new Map(state.probes)
      const existing = probes.get(key)
      probes.set(key, {
        key,
        category: event.category,
        provider: event.provider,
        label: event.label,
        status: 'completed',
        score: event.score,
        durationMs: event.durationMs,
        error: event.error,
        startedAt: existing?.startedAt ?? now,
      })
      return { ...state, probes }
    }
    case 'category.completed':
      return {
        ...state,
        categoryScores: { ...state.categoryScores, [event.category]: event.score },
      }
    case 'done':
      return {
        ...state,
        phase: 'done',
        overall: event.overall,
        letter: event.letter,
        categoryScores: event.scores,
      }
    case 'failed':
      return { ...state, phase: 'failed', error: event.error }
  }
}
```

### Step 5: Verify tests pass + typecheck

Run: `pnpm test tests/unit/web/grade-reducer.test.ts`
Expected: PASS — 11 tests.

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/web/lib/types.ts src/web/lib/grade-reducer.ts tests/unit/web/grade-reducer.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): pure grade-event reducer + shared frontend types"
```

---

## Task 3 — API wrappers + `useCreateGrade` hook

**Files:**
- Create: `src/web/lib/api.ts`
- Create: `src/web/hooks/useCreateGrade.ts`

### Step 1: Create `src/web/lib/api.ts`

Defines typed fetch wrappers + response shape discrimination. Same-origin; cookies travel by default.

```ts
import type { CategoryId } from './types.ts'

export interface GradeSummary {
  id: string
  url: string
  domain: string
  tier: 'free' | 'paid'
  status: 'queued' | 'running' | 'done' | 'failed'
  overall: number | null
  letter: string | null
  scores: Record<CategoryId, number | null> | null
  createdAt: string
  updatedAt: string
}

export interface CreateGradeOk { ok: true; gradeId: string }
export interface CreateGradeRateLimited {
  ok: false
  kind: 'rate_limited'
  paywall: 'email' | 'pay'
  limit: number
  used: number
  retryAfter: number
}
export interface CreateGradeValidationError { ok: false; kind: 'validation'; message: string }
export interface CreateGradeUnknownError { ok: false; kind: 'unknown'; status: number }

export type CreateGradeResponse = CreateGradeOk | CreateGradeRateLimited | CreateGradeValidationError | CreateGradeUnknownError

export async function postGrade(url: string): Promise<CreateGradeResponse> {
  let res: Response
  try {
    res = await fetch('/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ url }),
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }

  if (res.status === 202) {
    const body = (await res.json()) as { gradeId: string }
    return { ok: true, gradeId: body.gradeId }
  }
  if (res.status === 429) {
    const body = (await res.json()) as { paywall: 'email' | 'pay'; limit: number; used: number; retryAfter: number }
    return { ok: false, kind: 'rate_limited', ...body }
  }
  if (res.status === 400) {
    let message = 'Invalid URL'
    try {
      const body = (await res.json()) as { error?: { issues?: { message: string }[] } }
      const first = body.error?.issues?.[0]
      if (first) message = first.message
    } catch { /* keep default */ }
    return { ok: false, kind: 'validation', message }
  }
  return { ok: false, kind: 'unknown', status: res.status }
}

export async function getGrade(id: string): Promise<GradeSummary | null> {
  const res = await fetch(`/grades/${id}`, { credentials: 'include' })
  if (res.status === 404 || res.status === 403) return null
  if (!res.ok) return null
  return (await res.json()) as GradeSummary
}
```

### Step 2: Create `src/web/hooks/useCreateGrade.ts`

```ts
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postGrade, type CreateGradeResponse } from '../lib/api.ts'

export interface UseCreateGradeResult {
  create: (url: string) => Promise<void>
  pending: boolean
  error: string | null
}

export function useCreateGrade(): UseCreateGradeResult {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function create(url: string): Promise<void> {
    setPending(true)
    setError(null)
    const result: CreateGradeResponse = await postGrade(url)
    setPending(false)
    if (result.ok) {
      navigate(`/g/${result.gradeId}`)
      return
    }
    if (result.kind === 'rate_limited') {
      navigate(`/email?retry=${result.retryAfter}`)
      return
    }
    if (result.kind === 'validation') {
      setError(result.message)
      return
    }
    setError(`Request failed (${result.status})`)
  }

  return { create, pending, error }
}
```

### Step 3: Typecheck

Run: `pnpm typecheck`
Expected: clean.

No tests yet — `useCreateGrade` is glue that will be exercised through `LandingPage.test.tsx` in Task 6. `api.ts` is exercised by real HTTP in Plan 6a's integration tests; unit-testing the fetch wrapper would test nothing but `fetch` mocking.

### Step 4: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/web/lib/api.ts src/web/hooks/useCreateGrade.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): API wrappers + useCreateGrade hook"
```

---

## Task 4 — `useGradeEvents` hook

**Files:**
- Create: `src/web/hooks/useGradeEvents.ts`

### Step 1: Create `src/web/hooks/useGradeEvents.ts`

```ts
import { useEffect, useReducer, useState } from 'react'
import { initialGradeState, reduceGradeEvents } from '../lib/grade-reducer.ts'
import type { GradeEvent, GradeState } from '../lib/types.ts'

export interface UseGradeEventsResult {
  state: GradeState
  connected: boolean
}

export function useGradeEvents(gradeId: string): UseGradeEventsResult {
  const [state, dispatch] = useReducer(
    (s: GradeState, e: GradeEvent) => reduceGradeEvents(s, e, performance.now()),
    undefined,
    initialGradeState,
  )
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const es = new EventSource(`/grades/${gradeId}/events`, { withCredentials: true })
    es.onopen = (): void => setConnected(true)
    es.onerror = (): void => setConnected(false)
    es.onmessage = (ev: MessageEvent<string>): void => {
      try {
        dispatch(JSON.parse(ev.data) as GradeEvent)
      } catch {
        // Ignore malformed; server-side invariants are tight (Plan 6a Task 13 verified)
      }
    }
    return () => {
      es.close()
    }
  }, [gradeId])

  return { state, connected }
}
```

### Step 2: Typecheck

Run: `pnpm typecheck`
Expected: clean.

No unit test for the hook — covered indirectly by `LiveGradePage.test.tsx` (stubs the hook) in Task 8.

### Step 3: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/web/hooks/useGradeEvents.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): useGradeEvents hook (EventSource → reducer → state)"
```

---

## Task 5 — `Header`, `UrlForm`, `StatusBar` components

**Files:**
- Create: `src/web/components/Header.tsx`
- Create: `src/web/components/UrlForm.tsx`
- Create: `src/web/components/StatusBar.tsx`
- Create: `tests/unit/web/components/UrlForm.test.tsx`
- Create: `tests/unit/web/components/StatusBar.test.tsx`

### Step 1: Create `src/web/components/Header.tsx`

Minimal top bar. No nav links yet (the only destination in MVP is `/`, which the logo handles).

```tsx
import { Link } from 'react-router-dom'

export function Header(): JSX.Element {
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-bg-sidebar)] px-4 py-2 text-xs">
      <Link to="/" className="text-[var(--color-brand)]">geo-reporter</Link>
    </header>
  )
}
```

### Step 2: Write failing `UrlForm` tests

Create `tests/unit/web/components/UrlForm.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UrlForm } from '../../../../src/web/components/UrlForm.tsx'

describe('UrlForm', () => {
  it('calls onSubmit with the trimmed URL when the button is clicked', async () => {
    const onSubmit = vi.fn()
    render(<UrlForm onSubmit={onSubmit} pending={false} />)
    await userEvent.type(screen.getByRole('textbox'), '  https://acme.com  ')
    await userEvent.click(screen.getByRole('button', { name: /grade/i }))
    expect(onSubmit).toHaveBeenCalledWith('https://acme.com')
  })

  it('does not call onSubmit on empty input', async () => {
    const onSubmit = vi.fn()
    render(<UrlForm onSubmit={onSubmit} pending={false} />)
    await userEvent.click(screen.getByRole('button', { name: /grade/i }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renders error message when errorMessage prop is set', () => {
    render(<UrlForm onSubmit={() => undefined} pending={false} errorMessage="Invalid URL" />)
    expect(screen.getByText('Invalid URL')).toBeInTheDocument()
  })

  it('disables button when pending', () => {
    render(<UrlForm onSubmit={() => undefined} pending={true} />)
    expect(screen.getByRole('button', { name: /grade/i })).toBeDisabled()
  })
})
```

Also add `tests/unit/web/setup.ts` (referenced implicitly via happy-dom + testing-library's matchers):
```ts
import '@testing-library/jest-dom/vitest'
```

And reference it in `vitest.config.ts` by extending the test block:
```ts
test: {
  // ...existing
  setupFiles: ['./tests/unit/web/setup.ts'],   // loaded for all tests; harmless in node env
}
```

If `setupFiles` is already set, append to the array.

### Step 3: Verify tests fail

Run: `pnpm test tests/unit/web/components/UrlForm.test.tsx`
Expected: FAIL — module missing.

### Step 4: Implement `src/web/components/UrlForm.tsx`

```tsx
import { useState, type FormEvent } from 'react'

export interface UrlFormProps {
  onSubmit: (url: string) => void
  pending: boolean
  errorMessage?: string
}

export function UrlForm(props: UrlFormProps): JSX.Element {
  const [value, setValue] = useState('')

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    props.onSubmit(trimmed)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://..."
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-brand)]"
          disabled={props.pending}
        />
        <button
          type="submit"
          disabled={props.pending}
          className="bg-[var(--color-brand)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
        >
          {props.pending ? 'grading…' : 'grade'}
        </button>
      </div>
      {props.errorMessage !== undefined && (
        <div className="text-[var(--color-warn)] text-xs">{props.errorMessage}</div>
      )}
    </form>
  )
}
```

### Step 5: Write failing `StatusBar` tests

Create `tests/unit/web/components/StatusBar.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from '../../../../src/web/components/StatusBar.tsx'

describe('StatusBar', () => {
  it('highlights the running dot when phase is running', () => {
    render(<StatusBar phase="running" scraped={null} />)
    const runningEl = screen.getByText(/running/i).parentElement
    expect(runningEl?.className).toContain('color-brand')
  })

  it('shows scraped info when scraped payload is passed', () => {
    render(<StatusBar phase="scraped" scraped={{ rendered: true, textLength: 5432 }} />)
    expect(screen.getByText(/5432 chars/i)).toBeInTheDocument()
    expect(screen.getByText(/rendered/i)).toBeInTheDocument()
  })
})
```

### Step 6: Verify tests fail

Run: `pnpm test tests/unit/web/components/StatusBar.test.tsx`
Expected: FAIL.

### Step 7: Implement `src/web/components/StatusBar.tsx`

```tsx
import type { Phase } from '../lib/types.ts'

export interface StatusBarProps {
  phase: Phase
  scraped: { rendered: boolean; textLength: number } | null
}

const STEPS: { key: Phase; label: string }[] = [
  { key: 'queued', label: 'queued' },
  { key: 'running', label: 'running' },
  { key: 'scraped', label: 'scraped' },
  { key: 'done', label: 'done' },
]

function phaseRank(phase: Phase): number {
  switch (phase) {
    case 'queued': return 0
    case 'running': return 1
    case 'scraped': return 2
    case 'done': return 3
    case 'failed': return 3
  }
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  const currentRank = phaseRank(props.phase)
  return (
    <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
      {STEPS.map((step) => {
        const rank = phaseRank(step.key)
        const isCurrent = rank === currentRank
        const isPast = rank < currentRank
        const color = isCurrent
          ? 'text-[var(--color-brand)]'
          : isPast
          ? 'text-[var(--color-good-dim)]'
          : 'text-[var(--color-fg-faint)]'
        return (
          <span key={step.key} className={color}>● {step.label}</span>
        )
      })}
      {props.scraped !== null && (
        <span className="ml-4 text-[var(--color-fg-dim)]">
          {props.scraped.rendered ? 'rendered' : 'static'} · {props.scraped.textLength} chars
        </span>
      )}
    </div>
  )
}
```

### Step 8: Verify tests pass + typecheck

Run: `pnpm test tests/unit/web/components/`
Expected: PASS — 6 tests.

Run: `pnpm typecheck`
Expected: clean.

### Step 9: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/web/components/Header.tsx src/web/components/UrlForm.tsx src/web/components/StatusBar.tsx tests/unit/web/setup.ts tests/unit/web/components/UrlForm.test.tsx tests/unit/web/components/StatusBar.test.tsx vitest.config.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): Header + UrlForm + StatusBar components"
```

---

## Task 6 — `CategoryTile`, `ProbeLogRow`, `GradeLetter` components

**Files:**
- Create: `src/web/components/CategoryTile.tsx`
- Create: `src/web/components/ProbeLogRow.tsx`
- Create: `src/web/components/GradeLetter.tsx`
- Create: `tests/unit/web/components/CategoryTile.test.tsx`
- Create: `tests/unit/web/components/ProbeLogRow.test.tsx`

### Step 1: Write failing `CategoryTile` tests

Create `tests/unit/web/components/CategoryTile.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CategoryTile } from '../../../../src/web/components/CategoryTile.tsx'

describe('CategoryTile', () => {
  it('renders "..." when score is null and phase is running', () => {
    render(<CategoryTile category="seo" weight={10} score={null} phase="running" />)
    expect(screen.getByText('SEO · 10%')).toBeInTheDocument()
    expect(screen.getByText('...')).toBeInTheDocument()
  })

  it('renders the score as a number when provided', () => {
    render(<CategoryTile category="discoverability" weight={30} score={85} phase="done" />)
    expect(screen.getByText('85')).toBeInTheDocument()
  })

  it('shows "—" + unscored label when score is null and phase is done (accuracy skipped)', () => {
    render(<CategoryTile category="accuracy" weight={20} score={null} phase="done" />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText(/unscored/i)).toBeInTheDocument()
  })

  it('uses green class for score ≥ 80', () => {
    const { container } = render(<CategoryTile category="seo" weight={10} score={90} phase="done" />)
    expect(container.querySelector('[data-score]')?.className).toContain('color-good')
  })

  it('uses warn class for score between 60 and 79', () => {
    const { container } = render(<CategoryTile category="seo" weight={10} score={70} phase="done" />)
    expect(container.querySelector('[data-score]')?.className).toContain('color-warn')
  })
})
```

### Step 2: Verify tests fail

Run: `pnpm test tests/unit/web/components/CategoryTile.test.tsx`
Expected: FAIL.

### Step 3: Implement `src/web/components/CategoryTile.tsx`

```tsx
import type { CategoryId, Phase } from '../lib/types.ts'

export interface CategoryTileProps {
  category: CategoryId
  weight: number
  score: number | null
  phase: Phase
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-[var(--color-good)]'
  if (score >= 60) return 'text-[var(--color-warn)]'
  return 'text-[var(--color-fg-dim)]'
}

export function CategoryTile(props: CategoryTileProps): JSX.Element {
  const { category, weight, score, phase } = props
  const hasScore = score !== null
  const isDoneWithNull = !hasScore && phase === 'done'

  return (
    <div className="border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-3">
      <div className="text-[10px] tracking-wider text-[var(--color-fg-muted)] uppercase">
        {category} · {weight}%
      </div>
      <div
        data-score
        className={
          hasScore
            ? `text-2xl mt-1 ${scoreColor(score)}`
            : 'text-2xl mt-1 text-[var(--color-fg-dim)]'
        }
      >
        {hasScore ? score : isDoneWithNull ? '—' : '...'}
      </div>
      {isDoneWithNull && (
        <div className="text-[10px] text-[var(--color-fg-muted)] mt-1">unscored</div>
      )}
    </div>
  )
}
```

### Step 4: Write failing `ProbeLogRow` tests

Create `tests/unit/web/components/ProbeLogRow.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProbeLogRow } from '../../../../src/web/components/ProbeLogRow.tsx'
import type { ProbeEntry } from '../../../../src/web/lib/types.ts'

function makeProbe(overrides: Partial<ProbeEntry> = {}): ProbeEntry {
  return {
    key: 'seo:-:title',
    category: 'seo',
    provider: null,
    label: 'title',
    status: 'completed',
    score: 100,
    durationMs: 123,
    error: null,
    startedAt: 1000,
    ...overrides,
  }
}

describe('ProbeLogRow', () => {
  it('shows a ✓ glyph for completed probes', () => {
    render(<ProbeLogRow probe={makeProbe({ status: 'completed' })} />)
    expect(screen.getByText(/✓/)).toBeInTheDocument()
  })

  it('shows a ▶ glyph for started probes', () => {
    render(<ProbeLogRow probe={makeProbe({ status: 'started', score: null })} />)
    expect(screen.getByText(/▶/)).toBeInTheDocument()
  })

  it('renders category/provider/label (with - for null provider)', () => {
    render(<ProbeLogRow probe={makeProbe({ provider: null, label: 'title' })} />)
    expect(screen.getByText(/seo\/-\/title/)).toBeInTheDocument()
  })

  it('renders the error message when present', () => {
    render(<ProbeLogRow probe={makeProbe({ status: 'completed', score: null, error: 'rate limited' })} />)
    expect(screen.getByText(/rate limited/)).toBeInTheDocument()
  })
})
```

### Step 5: Verify tests fail

Run: `pnpm test tests/unit/web/components/ProbeLogRow.test.tsx`
Expected: FAIL.

### Step 6: Implement `src/web/components/ProbeLogRow.tsx`

```tsx
import type { ProbeEntry } from '../lib/types.ts'

export interface ProbeLogRowProps {
  probe: ProbeEntry
}

export function ProbeLogRow(props: ProbeLogRowProps): JSX.Element {
  const { probe } = props
  const glyph = probe.status === 'completed' ? '✓' : '▶'
  const glyphColor =
    probe.error !== null
      ? 'text-[var(--color-warn)]'
      : probe.status === 'completed'
      ? 'text-[var(--color-good)]'
      : 'text-[var(--color-fg-dim)]'
  const providerLabel = probe.provider ?? '-'
  const scoreText = probe.score !== null ? `· ${probe.score}` : ''

  return (
    <div className="flex gap-2 text-xs font-mono py-0.5">
      <span className={glyphColor}>{glyph}</span>
      <span className="text-[var(--color-fg-dim)]">{`${probe.category}/${providerLabel}/${probe.label}`}</span>
      <span className="text-[var(--color-fg-muted)]">{scoreText}</span>
      {probe.error !== null && (
        <span className="text-[var(--color-warn)]">· {probe.error}</span>
      )}
    </div>
  )
}
```

### Step 7: Implement `src/web/components/GradeLetter.tsx`

No unit test — purely presentational, component-integration test in Task 8 will render it via LiveGradePage.

```tsx
export interface GradeLetterProps {
  letter: string
  overall: number
}

export function GradeLetter(props: GradeLetterProps): JSX.Element {
  return (
    <div className="flex items-baseline gap-4">
      <div className="text-6xl font-bold text-[var(--color-brand)]">{props.letter}</div>
      <div className="text-xl text-[var(--color-fg-dim)]">{props.overall}/100</div>
    </div>
  )
}
```

### Step 8: Verify tests pass + typecheck

Run: `pnpm test tests/unit/web/components/`
Expected: PASS — 13 tests total (6 prior + 5 CategoryTile + 4 ProbeLogRow = 15 actually; count from output).

Actually recount: StatusBar 2 + UrlForm 4 + CategoryTile 5 + ProbeLogRow 4 = 15. Expected from `pnpm test tests/unit/web/components/`: 15 PASS.

Run: `pnpm typecheck`
Expected: clean.

### Step 9: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/web/components/CategoryTile.tsx src/web/components/ProbeLogRow.tsx src/web/components/GradeLetter.tsx tests/unit/web/components/CategoryTile.test.tsx tests/unit/web/components/ProbeLogRow.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): CategoryTile + ProbeLogRow + GradeLetter components"
```

---

## Task 7 — `LandingPage`

**Files:**
- Create: `src/web/pages/LandingPage.tsx`
- Modify: `src/web/App.tsx` (wire Router + route table; introduce layout)

### Step 1: Implement `src/web/pages/LandingPage.tsx`

```tsx
import { useCreateGrade } from '../hooks/useCreateGrade.ts'
import { UrlForm } from '../components/UrlForm.tsx'

export function LandingPage(): JSX.Element {
  const { create, pending, error } = useCreateGrade()

  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">landing</div>
      <h1 className="text-3xl mt-2 mb-2 text-[var(--color-fg)]">How well do LLMs know your site?</h1>
      <p className="text-[var(--color-fg-dim)] mb-8">
        We scrape your page, ask four LLMs about you, and score the results across six categories.
      </p>
      <UrlForm
        onSubmit={(url) => { void create(url) }}
        pending={pending}
        {...(error !== null ? { errorMessage: error } : {})}
      />
    </div>
  )
}
```

### Step 2: Rewrite `src/web/App.tsx` with Router + layout + route table

```tsx
import { Routes, Route } from 'react-router-dom'
import { Header } from './components/Header.tsx'
import { LandingPage } from './pages/LandingPage.tsx'

export function App(): JSX.Element {
  return (
    <div className="min-h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-fg)]">
      <Header />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="*" element={<div className="p-8 text-[var(--color-fg-dim)]">404 — route not implemented yet</div>} />
        </Routes>
      </main>
    </div>
  )
}
```

### Step 3: Typecheck

Run: `pnpm typecheck`
Expected: clean.

### Step 4: Manual smoke

```bash
pnpm dev:server &
pnpm dev:worker &
pnpm dev:web &
sleep 3
curl -sf http://localhost:5173 | grep -q "How well do LLMs know your site" && echo OK || echo FAIL
kill %1 %2 %3 2>/dev/null
```
Expected: `OK`.

### Step 5: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/web/pages/LandingPage.tsx src/web/App.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): LandingPage + App layout with router"
```

---

## Task 8 — `LiveGradePage` + component-integration test

**Files:**
- Create: `src/web/pages/LiveGradePage.tsx`
- Create: `tests/unit/web/components/LiveGradePage.test.tsx`
- Modify: `src/web/App.tsx` (add `/g/:id` route)

### Step 1: Write failing `LiveGradePage.test.tsx`

Create `tests/unit/web/components/LiveGradePage.test.tsx`. The test stubs `useGradeEvents` via `vi.mock` and asserts the page renders tiles + log + done state:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { GradeState } from '../../../../src/web/lib/types.ts'

const stubState: { current: GradeState } = { current: {} as GradeState }
vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: () => ({ state: stubState.current, connected: true }),
}))

import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/g/${id}`]}>
      <Routes>
        <Route path="/g/:id" element={<LiveGradePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('LiveGradePage', () => {
  it('renders six category tiles + a "status" region while running', () => {
    stubState.current = {
      phase: 'running',
      scraped: null,
      probes: new Map(),
      categoryScores: {
        discoverability: null, recognition: null, accuracy: null,
        coverage: null, citation: null, seo: null,
      },
      overall: null, letter: null, error: null,
    }
    renderAt('abc-123')
    expect(screen.getByText(/DISCOVERABILITY · 30%/)).toBeInTheDocument()
    expect(screen.getByText(/SEO · 10%/)).toBeInTheDocument()
    // Six tiles each show "..." while null+running
    expect(screen.getAllByText('...').length).toBe(6)
  })

  it('renders the GradeLetter + overall when phase is done', () => {
    stubState.current = {
      phase: 'done',
      scraped: { rendered: false, textLength: 3000 },
      probes: new Map(),
      categoryScores: {
        discoverability: 80, recognition: 75, accuracy: 60, coverage: 70, citation: 100, seo: 90,
      },
      overall: 78, letter: 'C+', error: null,
    }
    renderAt('done-grade')
    expect(screen.getByText('C+')).toBeInTheDocument()
    expect(screen.getByText('78/100')).toBeInTheDocument()
  })
})
```

### Step 2: Verify tests fail

Run: `pnpm test tests/unit/web/components/LiveGradePage.test.tsx`
Expected: FAIL — module missing.

### Step 3: Implement `src/web/pages/LiveGradePage.tsx`

```tsx
import { useParams, Link } from 'react-router-dom'
import { useGradeEvents } from '../hooks/useGradeEvents.ts'
import { StatusBar } from '../components/StatusBar.tsx'
import { CategoryTile } from '../components/CategoryTile.tsx'
import { ProbeLogRow } from '../components/ProbeLogRow.tsx'
import { GradeLetter } from '../components/GradeLetter.tsx'
import { CATEGORY_ORDER, CATEGORY_WEIGHTS } from '../lib/types.ts'

export function LiveGradePage(): JSX.Element {
  const { id } = useParams<{ id: string }>()
  if (id === undefined) return <div className="p-8 text-[var(--color-warn)]">invalid grade id</div>
  const { state } = useGradeEvents(id)

  if (state.phase === 'failed') {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">grade failed</div>
        <h2 className="text-xl text-[var(--color-warn)] mt-2 mb-4">
          {state.error ?? 'unknown error'}
        </h2>
        <Link to="/" className="text-[var(--color-brand)] underline">try another URL →</Link>
      </div>
    )
  }

  const sortedProbes = [...state.probes.values()].sort((a, b) => a.startedAt - b.startedAt)

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">live grade</div>

      {state.phase === 'done' && state.letter !== null && state.overall !== null ? (
        <div className="mt-4 mb-6">
          <GradeLetter letter={state.letter} overall={state.overall} />
        </div>
      ) : (
        <div className="mt-2 mb-6">
          <StatusBar phase={state.phase} scraped={state.scraped} />
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-8">
        {CATEGORY_ORDER.map((cat) => (
          <CategoryTile
            key={cat}
            category={cat}
            weight={CATEGORY_WEIGHTS[cat]}
            score={state.categoryScores[cat]}
            phase={state.phase}
          />
        ))}
      </div>

      <div className="border-t border-[var(--color-line)] pt-4">
        <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase mb-2">probes</div>
        <div className="flex flex-col">
          {sortedProbes.map((probe) => (
            <ProbeLogRow key={probe.key} probe={probe} />
          ))}
          {sortedProbes.length === 0 && (
            <div className="text-xs text-[var(--color-fg-muted)]">— waiting for first probe —</div>
          )}
        </div>
      </div>

      {state.phase === 'done' && (
        <div className="mt-8 border-t border-[var(--color-line)] pt-4">
          <div className="text-[var(--color-fg-dim)] text-sm">
            Get the full report — recommendations + PDF — <span className="text-[var(--color-brand)]">$19</span>.
          </div>
          <button
            type="button"
            disabled
            className="mt-2 bg-[var(--color-brand-dim)] text-[var(--color-bg)] px-4 py-2 opacity-50 cursor-not-allowed"
          >
            Checkout — coming soon
          </button>
        </div>
      )}
    </div>
  )
}
```

### Step 4: Wire the `/g/:id` route in `App.tsx`

Modify `src/web/App.tsx`. Add import + route:
```tsx
import { LiveGradePage } from './pages/LiveGradePage.tsx'
```
Inside `<Routes>`, between `<Route path="/" />` and `<Route path="*" />`, add:
```tsx
<Route path="/g/:id" element={<LiveGradePage />} />
```

### Step 5: Verify tests pass + typecheck

Run: `pnpm test tests/unit/web/components/LiveGradePage.test.tsx`
Expected: PASS — 2 tests.

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/web/pages/LiveGradePage.tsx src/web/App.tsx tests/unit/web/components/LiveGradePage.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): LiveGradePage with SSE-driven scorecard + probe log"
```

---

## Task 9 — `EmailGatePage` + `NotFoundPage`

**Files:**
- Create: `src/web/pages/EmailGatePage.tsx`
- Create: `src/web/pages/NotFoundPage.tsx`
- Modify: `src/web/App.tsx` (wire routes)

### Step 1: Implement `src/web/pages/EmailGatePage.tsx`

```tsx
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const leftoverMinutes = minutes % 60
  return `${hours}h ${leftoverMinutes}m`
}

export function EmailGatePage(): JSX.Element {
  const [params] = useSearchParams()
  const retrySeconds = Number(params.get('retry') ?? '0')
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (email.trim().length === 0) return
    setPending(true)
    setMessage(null)
    const res = await fetch('/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: email.trim() }),
    }).catch(() => null)
    setPending(false)
    if (res === null) {
      setMessage('Network error. Try again.')
      return
    }
    if (res.status === 404) {
      setMessage('Magic-link email is coming soon (Plan 7). For now, swap cookies or wait.')
      return
    }
    if (!res.ok) {
      setMessage(`Request failed (${res.status}).`)
      return
    }
    setMessage('Check your email for a sign-in link.')
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">paywall</div>
      <h1 className="text-2xl mt-2 mb-2 text-[var(--color-fg)]">You've hit your free limit</h1>
      <p className="text-[var(--color-fg-dim)] mb-4">
        3 grades per 24 hours for anonymous visitors. Verify your email and we'll unlock{' '}
        <span className="text-[var(--color-good)]">10 more</span>.
      </p>
      {retrySeconds > 0 && (
        <div className="text-xs text-[var(--color-fg-muted)] mb-4">
          Or come back in <span className="text-[var(--color-fg-dim)]">{formatRetry(retrySeconds)}</span>.
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-brand)]"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={pending}
          className="bg-[var(--color-brand)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
        >
          {pending ? '...' : 'send link'}
        </button>
      </form>

      {message !== null && (
        <div className="text-xs text-[var(--color-fg-dim)] mt-4">{message}</div>
      )}

      <div className="mt-12">
        <Link to="/" className="text-[var(--color-brand)] text-xs">← back to home</Link>
      </div>
    </div>
  )
}
```

### Step 2: Implement `src/web/pages/NotFoundPage.tsx`

```tsx
import { Link } from 'react-router-dom'

export function NotFoundPage(): JSX.Element {
  return (
    <div className="max-w-xl mx-auto px-4 py-24 text-center">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase mb-2">error</div>
      <h1 className="text-3xl text-[var(--color-warn)] mb-4">404</h1>
      <p className="text-[var(--color-fg-dim)] mb-8">route not found</p>
      <Link to="/" className="text-[var(--color-brand)]">← back to home</Link>
    </div>
  )
}
```

### Step 3: Wire routes in `App.tsx`

Modify `src/web/App.tsx`. Imports:
```tsx
import { EmailGatePage } from './pages/EmailGatePage.tsx'
import { NotFoundPage } from './pages/NotFoundPage.tsx'
```
Replace the existing `<Route path="*" />` placeholder and add `/email`:
```tsx
<Route path="/" element={<LandingPage />} />
<Route path="/g/:id" element={<LiveGradePage />} />
<Route path="/email" element={<EmailGatePage />} />
<Route path="*" element={<NotFoundPage />} />
```

### Step 4: Verify + typecheck

Run: `pnpm test`
Expected: all passing (no new tests in this task, but existing ones must not regress).

Run: `pnpm typecheck`
Expected: clean.

### Step 5: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/web/pages/EmailGatePage.tsx src/web/pages/NotFoundPage.tsx src/web/App.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): EmailGatePage + NotFoundPage + wire remaining routes"
```

---

## Task 10 — Prod `serveStatic` catch-all in Hono

**Files:**
- Modify: `src/server/app.ts`

### Step 1: Add serveStatic mount in production

Modify `src/server/app.ts`. Import at top:
```ts
import { serveStatic } from '@hono/node-server/serve-static'
```

At the END of `buildApp(deps)`, BEFORE `return app`:
```ts
  if (deps.env.NODE_ENV === 'production') {
    // Serve built frontend from dist/web. 404s fall through to the SPA's index.html
    // so React Router handles deep links (e.g. /g/:id) on page refresh.
    app.use('/assets/*', serveStatic({ root: './dist/web' }))
    app.get('*', serveStatic({ root: './dist/web', path: 'index.html' }))
  }
```

### Step 2: Typecheck

Run: `pnpm typecheck`
Expected: clean.

### Step 3: Verify unit tests still pass

Run: `pnpm test`
Expected: all passing. The healthz unit test uses `NODE_ENV: 'test'` so serveStatic branch is inactive; no regression.

### Step 4: Manual production smoke (optional but recommended)

```bash
pnpm build
cd dist && NODE_ENV=production PORT=7778 node server.js &
sleep 2
# Root returns HTML (index.html)
curl -sf http://localhost:7778/ | grep -q 'id="root"' && echo OK-root || echo FAIL-root
# Unknown route returns same HTML (SPA fallback)
curl -sf http://localhost:7778/g/not-real-id | grep -q 'id="root"' && echo OK-fallback || echo FAIL-fallback
# Healthz still JSON (route mounted before the catch-all)
curl -sf http://localhost:7778/healthz | grep -q '"ok":' && echo OK-healthz || echo FAIL-healthz
kill %1
cd ..
```
Expected: all three `OK-*` lines.

### Step 5: Commit

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add src/server/app.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(v3): serve built frontend from Hono in production"
```

---

## Task 11 — README + final verification

**Files:**
- Modify: `README.md`

### Step 1: Update README "What runs today" table + Commands + new dev section

Read `README.md`. Make these edits:

1. In the "What runs today" table, add a new row after the `GET /grades/:id/events` line:
   ```
   | **React terminal UI** (`pnpm dev:web` on :5173) | Works. Landing, LiveGrade, EmailGate, 404. SSE-driven scorecard. |
   ```
   Update the "Not implemented yet" cell to remove "React UI" — now it reads "magic-link auth, Stripe checkout, report HTML/PDF".

2. In the "Commands" block, add the three new scripts after `pnpm dev:worker`:
   ```
   pnpm dev:web             # Vite dev server on :5173, HMR, proxies to :7777
   pnpm web:build           # vite build → dist/web/
   pnpm web:preview         # vite preview (serve dist/web)
   ```

3. Add a new section after "Running a grade via HTTP" titled "Running the React dev loop":
   ```md
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
   ```

4. In the Layout section, add under `src/web/`:
   ```
     web/                   # React frontend: pages, components, hooks, reducer
   ```

5. In the Roadmap, change Plan 6b from "Pending" to "**Done**".

Save the file.

### Step 2: Typecheck

Run: `pnpm typecheck`
Expected: clean.

### Step 3: Full unit test run

Run: `pnpm test`
Expected: previous 286 + ~11 reducer + ~15 components = **~312 total**. Report the actual count.

### Step 4: Full integration test run

Run: `pnpm test:integration`
Expected: 35 (unchanged from Plan 6a — no new integration tests in 6b).

### Step 5: Full build

Run: `pnpm build`
Expected: clean output with three bundles — `dist/server.js`, `dist/worker.js`, and `dist/web/` with `index.html` + `assets/*.js` + `assets/*.css`. Report file sizes.

### Step 6: Boundary grep

Should produce NO output:
```bash
grep -RE "from '\\.\\./\\.\\./(server|worker|store|db|queue|scraper|llm|scoring|accuracy)" src/web/ 2>/dev/null || true
grep -RE "from '\\.\\./(server|worker|store|db|queue|scraper|llm|scoring|accuracy)" src/web/ 2>/dev/null || true
```
Report any output. Empty = frontend truly isolated.

### Step 7: Commit README + report

```bash
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' add README.md
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "docs: document the React dev loop + refresh for Plan 6b shipped"
```

If earlier steps flagged issues, fix them in-branch. Otherwise report DONE with:
- Commit count since base
- Unit test count
- Integration test count
- Build output + sizes
- Manual smoke result (optional)

---

## Plan 6b completion checklist

- [ ] All 11 tasks committed.
- [ ] `pnpm typecheck` clean (both root + `tsconfig.web.json`).
- [ ] `pnpm test` green (~312).
- [ ] `pnpm test:integration` green (35 — no regressions).
- [ ] `pnpm build` produces `dist/server.js` + `dist/worker.js` + `dist/web/`.
- [ ] No imports from `src/{server,worker,store,db,queue,scraper,llm,scoring,accuracy}/` inside `src/web/`.
- [ ] Manual smoke: `pnpm dev:server` + `pnpm dev:worker` + `pnpm dev:web` → open http://localhost:5173 → paste URL → see live grade.

## Out of scope

- Magic-link auth wiring (Plan 7) — EmailGatePage submits to `/auth/magic` which 404s until then.
- Stripe checkout action (Plan 8) — done-state CTA is a disabled button.
- Report HTML/PDF rendering (Plan 9).
- `/my/grades` grade history (Plan 7 — needs auth).
- Playwright E2E (Plan 10).
- Favicon + brand OG metadata — placeholder in Plan 6b.
- Accessibility audit — use semantic HTML + focus rings; logged to production checklist for launch.
- Frontend-on-CDN deploy — logged to production checklist.
