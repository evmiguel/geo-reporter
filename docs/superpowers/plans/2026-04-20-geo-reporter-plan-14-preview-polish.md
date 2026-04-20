# Plan 14 — Preview polish + report-style alignment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) syntax.

**Goal:** (1) Letter grades on category tiles, (2) multi-phase "generating" status driven by SSE, (3) paid-preview teaser card, (4) hybrid styling alignment with the report.

**Architecture:** Shared `scoreToLetter` helper feeds both `GradeLetter` and the new per-tile letter. New reducer field `reportProbeCount` + new `ReportProgress` component consumes SSE events already emitted by the generate-report worker. `PaidReportPreview` is templated (static sample copy) so it renders without real probe data. Hybrid styling: keep dark theme, adopt mono numbers + report typography scale + 1px-border cards.

**Tech Stack:** React 18, Tailwind, Vitest 2. No new deps.

**Spec:** `docs/superpowers/specs/2026-04-20-geo-reporter-plan-14-preview-polish-design.md`

---

## Task 1: `scoreToLetter` shared helper

**Files:**
- Create: `src/scoring/letter.ts`
- Test: `tests/unit/scoring/letter.test.ts` (new)

- [ ] **Step 1: Failing test.** Create `tests/unit/scoring/letter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { scoreToLetter } from '../../../src/scoring/letter.ts'

describe('scoreToLetter', () => {
  it('maps 90+ to A', () => {
    expect(scoreToLetter(100)).toBe('A')
    expect(scoreToLetter(95)).toBe('A')
    expect(scoreToLetter(90)).toBe('A')
  })
  it('maps 80-89 to B', () => {
    expect(scoreToLetter(89)).toBe('B')
    expect(scoreToLetter(80)).toBe('B')
  })
  it('maps 70-79 to C', () => {
    expect(scoreToLetter(79)).toBe('C')
    expect(scoreToLetter(70)).toBe('C')
  })
  it('maps 60-69 to D', () => {
    expect(scoreToLetter(69)).toBe('D')
    expect(scoreToLetter(60)).toBe('D')
  })
  it('maps < 60 to F', () => {
    expect(scoreToLetter(59)).toBe('F')
    expect(scoreToLetter(0)).toBe('F')
    expect(scoreToLetter(-5)).toBe('F')
  })
  it('returns null for null score', () => {
    expect(scoreToLetter(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run** `pnpm test tests/unit/scoring/letter.test.ts` → expect FAIL.

- [ ] **Step 3: Implement.** Create `src/scoring/letter.ts`:

```ts
export type Letter = 'A' | 'B' | 'C' | 'D' | 'F'

export function scoreToLetter(score: number | null): Letter | null {
  if (score === null) return null
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}
```

- [ ] **Step 4: Run** → expect all PASS.

- [ ] **Step 5: Commit:**
```
git add src/scoring/letter.ts tests/unit/scoring/letter.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(scoring): scoreToLetter shared helper for A-F mapping"
```

---

## Task 2: Letter grade on `CategoryTile`

**Files:**
- Modify: `src/web/components/CategoryTile.tsx`
- Modify: `tests/unit/web/components/CategoryTile.test.tsx` (add cases)

- [ ] **Step 1: Write failing tests.** Read the existing test file first to match patterns. Append:

```tsx
import { scoreToLetter } from '../../../../src/scoring/letter.ts'

it('renders letter grade for numeric score', () => {
  render(
    <CategoryTile category="discoverability" weight={30} score={85} phase="done" />,
  )
  expect(screen.getByText('B')).toBeInTheDocument()
  expect(screen.getByText('85')).toBeInTheDocument()
})

it('omits letter when score is null (unscored)', () => {
  render(
    <CategoryTile category="accuracy" weight={20} score={null} phase="done" />,
  )
  // Letter is not rendered; the em-dash and "unscored" caption are (existing behavior).
  expect(screen.queryByText(/^[A-F]$/)).toBeNull()
  expect(screen.getByText('—')).toBeInTheDocument()
  expect(screen.getByText('unscored')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Update `src/web/components/CategoryTile.tsx`:**

```tsx
import React from 'react'
import type { CategoryId, Phase } from '../lib/types.ts'
import { scoreToLetter } from '../../scoring/letter.ts'

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
  const letter = scoreToLetter(score)

  return (
    <div className="border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-3">
      <div className="text-[10px] tracking-wider text-[var(--color-fg-muted)] uppercase">
        {category} · {weight}%
      </div>
      <div className="flex items-baseline justify-between mt-1">
        {letter !== null ? (
          <div className={`text-2xl font-mono ${hasScore ? scoreColor(score) : 'text-[var(--color-fg-dim)]'}`}>
            {letter}
          </div>
        ) : <div />}
        <div
          data-score
          className={
            hasScore
              ? `text-2xl font-mono ${scoreColor(score)}`
              : 'text-2xl font-mono text-[var(--color-fg-dim)]'
          }
        >
          {hasScore ? score : isDoneWithNull ? '—' : '...'}
        </div>
      </div>
      {isDoneWithNull && (
        <div className="text-[10px] text-[var(--color-fg-muted)] mt-1">unscored</div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run tests + typecheck.** Expect PASS; snapshot tests (if any) may need updating.

- [ ] **Step 5: Commit:**
```
git add src/web/components/CategoryTile.tsx tests/unit/web/components/CategoryTile.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): letter grade on each CategoryTile"
```

---

## Task 3: Reducer — `reportProbeCount`

**Files:**
- Modify: `src/web/lib/types.ts`
- Modify: `src/web/lib/grade-reducer.ts`
- Modify: `tests/unit/web/grade-reducer.test.ts` (or whatever the filename is — read to confirm)

- [ ] **Step 1: Failing tests.** Read the existing reducer test file. Add two cases:

```ts
it('resets reportProbeCount on report.started', () => {
  const base = { ...initialGradeState(), reportProbeCount: 5 }
  const next = reduceGradeEvents(base, { type: 'report.started' }, 0)
  expect(next.reportProbeCount).toBe(0)
})

it('increments reportProbeCount on report.probe.completed', () => {
  const base = { ...initialGradeState(), reportProbeCount: 2 }
  const next = reduceGradeEvents(
    base,
    { type: 'report.probe.completed', category: 'recognition', provider: 'gemini', label: 'prompt_1', score: 70, durationMs: 100, error: null },
    0,
  )
  expect(next.reportProbeCount).toBe(3)
})

it('initialGradeState has reportProbeCount=0', () => {
  expect(initialGradeState().reportProbeCount).toBe(0)
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Extend `GradeState`** in `src/web/lib/types.ts`. Add:

```ts
export interface GradeState {
  // ... existing fields
  reportProbeCount: number  // NEW — count of report.probe.completed since last report.started
}
```

- [ ] **Step 4: Update `initialGradeState`** and reducer in `src/web/lib/grade-reducer.ts`:

1. Add `reportProbeCount: 0` to the object returned by `initialGradeState`.

2. Update the `report.started` case:
```ts
case 'report.started':
  return { ...state, paidStatus: 'generating', reportProbeCount: 0 }
```

3. Update the `report.probe.completed` case to increment:
```ts
case 'report.probe.completed': {
  // ... existing probe map update ...
  return { ...state, probes, reportProbeCount: state.reportProbeCount + 1 }
}
```

Read the existing `report.probe.completed` branch to see what it currently returns, and preserve all its existing state mutations while adding `reportProbeCount: state.reportProbeCount + 1`.

- [ ] **Step 5: Run tests + typecheck.** All existing tests that construct `GradeState` literals will break — add `reportProbeCount: 0` to each. Typecheck will enumerate.

- [ ] **Step 6: Commit:**
```
git add src/web/lib/types.ts src/web/lib/grade-reducer.ts tests/unit/web/grade-reducer.test.ts
# plus any test files whose literal GradeState needed the new field
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(reducer): reportProbeCount tracks paid-probe events for progress UI"
```

---

## Task 4: `ReportProgress` component

**Files:**
- Create: `src/web/components/ReportProgress.tsx`
- Test: `tests/unit/web/components/ReportProgress.test.tsx` (new)

- [ ] **Step 1: Failing tests.** Create the test file:

```tsx
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReportProgress } from '../../../../src/web/components/ReportProgress.tsx'

afterEach(() => cleanup())

describe('ReportProgress', () => {
  it('shows "Checking payment" phase active when paidStatus=checking_out', () => {
    render(<ReportProgress paidStatus="checking_out" reportProbeCount={0} />)
    expect(screen.getByText(/checking payment/i)).toBeInTheDocument()
    // Running blind probes not yet active
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
  })

  it('shows probe counter during generating phase', () => {
    render(<ReportProgress paidStatus="generating" reportProbeCount={3} />)
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
    expect(screen.getByText(/3/)).toBeInTheDocument()
  })

  it('renders all four phase labels', () => {
    render(<ReportProgress paidStatus="generating" reportProbeCount={0} />)
    expect(screen.getByText(/checking payment/i)).toBeInTheDocument()
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
    expect(screen.getByText(/writing recommendations/i)).toBeInTheDocument()
    expect(screen.getByText(/rendering/i)).toBeInTheDocument()
  })

  it('renders nothing when paidStatus is none or ready', () => {
    const { container: c1 } = render(<ReportProgress paidStatus="none" reportProbeCount={0} />)
    expect(c1.firstChild).toBeNull()
    cleanup()
    const { container: c2 } = render(<ReportProgress paidStatus="ready" reportProbeCount={0} />)
    expect(c2.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Run** → FAIL (module not found).

- [ ] **Step 3: Implement `src/web/components/ReportProgress.tsx`:**

```tsx
import React from 'react'
import type { PaidStatus } from '../lib/types.ts'

interface Props {
  paidStatus: PaidStatus
  reportProbeCount: number
}

interface Phase {
  key: string
  label: string
  detail?: string
  status: 'done' | 'active' | 'pending'
}

function derivePhases(paidStatus: PaidStatus, probeCount: number): Phase[] {
  // 4 phases:
  //   checking (checking_out)
  //   probing  (generating, no recommendations yet — probeCount rising)
  //   writing  (generating, recommendations likely in progress — we collapse this
  //            into "generating" since frontend can't distinguish without a new
  //            event tracker; show as "Writing recommendations" if probeCount
  //            has stabilized; keep simple for now — always show probing detail)
  //   rendering (generating after recommendations, pre report.done)
  //
  // Simpler policy for v1: phase 1 = checking_out → active; everything else pending.
  // Once paidStatus flips to generating, phase 1 done, phase 2 active with probe
  // counter. Phases 3 and 4 remain "pending" until we add separate tracking.
  // This still provides visible progress + a counter, which is the big win.
  const checking: Phase['status'] = paidStatus === 'checking_out' ? 'active' : 'done'
  const probing: Phase['status'] =
    paidStatus === 'checking_out' ? 'pending' :
    paidStatus === 'generating' ? 'active' : 'done'
  const writing: Phase['status'] = 'pending'
  const rendering: Phase['status'] = 'pending'

  return [
    { key: 'checking', label: 'Checking payment', status: checking },
    {
      key: 'probing',
      label: 'Running blind probes',
      detail: probing === 'active' && probeCount > 0 ? `probe ${probeCount}` : undefined,
      status: probing,
    },
    { key: 'writing', label: 'Writing recommendations', status: writing },
    { key: 'rendering', label: 'Rendering your report', status: rendering },
  ]
}

export function ReportProgress({ paidStatus, reportProbeCount }: Props): JSX.Element | null {
  if (paidStatus === 'none' || paidStatus === 'ready' || paidStatus === 'failed') {
    return null
  }
  const phases = derivePhases(paidStatus, reportProbeCount)
  return (
    <div className="mt-6 border border-[var(--color-brand)] p-4">
      <div className="text-xs tracking-wider uppercase text-[var(--color-fg-muted)] mb-3">
        Generating your full report
      </div>
      <ul className="space-y-2">
        {phases.map((p) => (
          <li key={p.key} className="flex items-center gap-3 text-sm">
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              {p.status === 'done' && <span className="text-[var(--color-good)]">✓</span>}
              {p.status === 'active' && (
                <span className="inline-block w-3 h-3 rounded-full bg-[var(--color-brand)] animate-pulse" />
              )}
              {p.status === 'pending' && <span className="text-[var(--color-fg-muted)]">○</span>}
            </span>
            <span className={
              p.status === 'done' ? 'text-[var(--color-fg-dim)]' :
              p.status === 'active' ? 'text-[var(--color-fg)]' :
              'text-[var(--color-fg-muted)]'
            }>
              {p.label}
              {p.detail && <span className="text-[var(--color-fg-muted)] ml-2 font-mono text-xs">{p.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      <div className="text-xs text-[var(--color-fg-muted)] mt-3">Usually 30-60 seconds.</div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests + typecheck** → expect PASS.

- [ ] **Step 5: Commit:**
```
git add src/web/components/ReportProgress.tsx tests/unit/web/components/ReportProgress.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): ReportProgress — 4-phase generating status with probe counter"
```

---

## Task 5: Wire `ReportProgress` in LiveGradePage + remove old renders

**Files:**
- Modify: `src/web/pages/LiveGradePage.tsx`
- Modify: `src/web/components/BuyReportButton.tsx`
- Modify: `src/web/components/PaidReportStatus.tsx`
- Modify: `tests/unit/web/components/BuyReportButton.test.tsx` (remove or update 2 "generating" assertions)

- [ ] **Step 1: Read the existing `BuyReportButton.test.tsx`** to see the 2 "Generating your full report" tests. They assert the string appears after redeem/short-circuit-checkout. After this task, those assertions no longer apply (the render moved to page level). Rewrite them to assert the post-click state clears out the button (e.g., `queryByRole('button', { name: /redeem/i })` returns null) OR delete them since `LiveGradePage.generating.test.tsx` already covers the render-level contract.

Simplest: replace both test bodies to assert BuyReportButton is NOT mounted when paidStatus=generating. But since those tests mount BuyReportButton directly (not LiveGradePage), simpler still: delete the 2 tests outright. Page-level test in Task 6 / existing `LiveGradePage.generating.test.tsx` carries coverage.

- [ ] **Step 2: Update `BuyReportButton.tsx`** — drop the `mode === 'generating'` render block AND the `setMode('generating')` calls in `handleClick`. On successful redeem/short-circuit, just `await refresh()` and let the page-level `ReportProgress` take over (it mounts when `paidStatus !== 'none'`).

Remove: `Mode` includes `'generating'`, the `if (mode === 'generating')` render block, and any `setMode('generating')` assignments. Keep: idle / verify_email / email_sent branches. Handler logic for `result.kind === 'provider_outage'` stays.

- [ ] **Step 3: Update `PaidReportStatus.tsx`** — remove the `checking_out`/`generating` branch (moves to ReportProgress). Keep only `ready` and `failed`. LiveGradePage will render `<ReportProgress />` separately.

Change the signature: `status: 'ready' | 'failed'` only. LiveGradePage gates on `effectivePaidStatus === 'ready'` or `'failed'` to mount PaidReportStatus.

- [ ] **Step 4: Update `LiveGradePage.tsx`** — mount `ReportProgress` when `effectivePaidStatus === 'checking_out'` or `'generating'`; mount `PaidReportStatus` only for `ready`/`failed`. Also: `isFreeTierDone` should still hide BuyReportButton while generating, so the button unmounts correctly.

Rough shape:
```tsx
import { ReportProgress } from '../components/ReportProgress.tsx'
// ...
{(effectivePaidStatus === 'checking_out' || effectivePaidStatus === 'generating') && (
  <ReportProgress paidStatus={effectivePaidStatus} reportProbeCount={state.reportProbeCount} />
)}
{(effectivePaidStatus === 'ready' || effectivePaidStatus === 'failed') && (
  <PaidReportStatus
    status={effectivePaidStatus}
    reportId={state.reportId}
    reportToken={state.reportToken}
    error={state.error}
  />
)}
{effectivePaidStatus === 'ready' && credits === 0 && <BuyCreditsCTA />}
```

- [ ] **Step 5: Run tests + typecheck.** Fix any broken assertions. Run `pnpm test && pnpm typecheck`.

- [ ] **Step 6: Commit:**
```
git add src/web/pages/LiveGradePage.tsx src/web/components/BuyReportButton.tsx src/web/components/PaidReportStatus.tsx tests/unit/web/components/BuyReportButton.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): page-level ReportProgress replaces inline generating states"
```

---

## Task 6: `PaidReportPreview` teaser card

**Files:**
- Create: `src/web/components/PaidReportPreview.tsx`
- Test: `tests/unit/web/components/PaidReportPreview.test.tsx` (new)
- Modify: `src/web/pages/LiveGradePage.tsx` (mount it)

- [ ] **Step 1: Failing tests.** Create the test file:

```tsx
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PaidReportPreview } from '../../../../src/web/components/PaidReportPreview.tsx'

afterEach(() => cleanup())

describe('PaidReportPreview', () => {
  it('renders the graded domain + letter + overall in the mini cover', () => {
    render(
      <MemoryRouter>
        <PaidReportPreview domain="stripe.com" letter="B" overall={87} />
      </MemoryRouter>,
    )
    expect(screen.getByText('stripe.com')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText(/87/)).toBeInTheDocument()
  })

  it('renders two sample recommendation cards with a lock CTA', () => {
    render(
      <MemoryRouter>
        <PaidReportPreview domain="x.com" letter="C" overall={72} />
      </MemoryRouter>,
    )
    const cards = screen.getAllByText(/recommendation/i)
    expect(cards.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/unlock the full report/i)).toBeInTheDocument()
  })

  it('labels the preview so users know it is a sample', () => {
    render(
      <MemoryRouter>
        <PaidReportPreview domain="x.com" letter="C" overall={72} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/preview/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `src/web/components/PaidReportPreview.tsx`:**

```tsx
import React from 'react'

interface Props {
  domain: string
  letter: string
  overall: number
}

interface SampleRec {
  category: string
  title: string
  rationale: string
  impact: 'high' | 'medium' | 'low'
  effort: 'low' | 'medium' | 'high'
}

const SAMPLE_RECS: SampleRec[] = [
  {
    category: 'accuracy',
    title: 'Publish canonical product data',
    rationale: 'Several LLMs stated facts that didn\'t match your live site. Canonical JSON-LD metadata reduces drift.',
    impact: 'high',
    effort: 'medium',
  },
  {
    category: 'discoverability',
    title: 'Add an llms.txt at your root',
    rationale: 'Most providers now parse llms.txt when building their indexes. Without one, you rely on generic crawling.',
    impact: 'medium',
    effort: 'low',
  },
]

function impactBar(level: 'high' | 'medium' | 'low'): string {
  return level === 'high' ? 'w-full' : level === 'medium' ? 'w-2/3' : 'w-1/3'
}
function effortBar(level: 'low' | 'medium' | 'high'): string {
  return level === 'low' ? 'w-1/4' : level === 'medium' ? 'w-1/2' : 'w-3/4'
}

export function PaidReportPreview({ domain, letter, overall }: Props): JSX.Element {
  return (
    <section className="mt-6 border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-4">
      <div className="text-[10px] tracking-wider uppercase text-[var(--color-fg-muted)] mb-3">
        Preview · full report
      </div>

      {/* Mini cover */}
      <div className="flex items-baseline justify-between border-b border-[var(--color-line)] pb-3 mb-4">
        <div className="text-lg text-[var(--color-fg)]">{domain}</div>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-mono text-[var(--color-brand)]">{letter}</div>
          <div className="text-sm font-mono text-[var(--color-fg-dim)]">{overall}/100</div>
        </div>
      </div>

      {/* Sample recs */}
      <div className="space-y-3 mb-4">
        {SAMPLE_RECS.map((rec, i) => (
          <div key={rec.title} className="border border-[var(--color-line)] p-3">
            <div className="text-[10px] tracking-wider uppercase text-[var(--color-fg-muted)]">
              Recommendation #{i + 1} · {rec.category}
            </div>
            <div className="text-sm text-[var(--color-fg)] font-semibold mt-1">{rec.title}</div>
            <div className="text-xs text-[var(--color-fg-dim)] mt-1">{rec.rationale}</div>
            <div className="mt-2 text-[10px] text-[var(--color-fg-muted)] space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-12">IMPACT</span>
                <span className="flex-1 h-1 bg-[var(--color-line)]">
                  <span className={`block h-full bg-[var(--color-brand)] ${impactBar(rec.impact)}`} />
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-12">EFFORT</span>
                <span className="flex-1 h-1 bg-[var(--color-line)]">
                  <span className={`block h-full bg-[var(--color-fg-dim)] ${effortBar(rec.effort)}`} />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Lock overlay CTA */}
      <div className="text-center py-3 border-t border-[var(--color-line)]">
        <div className="text-xs text-[var(--color-fg-muted)]">🔒</div>
        <div className="text-sm text-[var(--color-fg)] mt-1">Unlock the full report</div>
        <div className="text-[10px] text-[var(--color-fg-muted)] mt-1">
          4 LLM providers · 5–8 tailored recommendations · HTML + PDF
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Mount in `LiveGradePage.tsx`.** Between the category tile grid and the `BuyReportButton`, when `isFreeTierDone && state.letter && state.overall !== null && gradeMeta`:

```tsx
{isFreeTierDone && gradeMeta && state.letter !== null && state.overall !== null && (
  <PaidReportPreview
    domain={gradeMeta.domain}
    letter={state.letter}
    overall={state.overall}
  />
)}
```

Import: `import { PaidReportPreview } from '../components/PaidReportPreview.tsx'`.

- [ ] **Step 5: Run tests + typecheck + full suite.**

- [ ] **Step 6: Commit:**
```
git add src/web/components/PaidReportPreview.tsx tests/unit/web/components/PaidReportPreview.test.tsx src/web/pages/LiveGradePage.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): PaidReportPreview teaser card before BuyReportButton"
```

---

## Task 7: Hybrid styling alignment

**Files:**
- Modify: `src/web/pages/LiveGradePage.tsx`
- Modify: `src/web/components/HowWeGradeCard.tsx`
- Modify: `src/web/components/GradeLetter.tsx`
- Modify: `src/web/components/CategoryTile.tsx` (already touched in Task 2 — verify mono font is applied)

Goal: same dark palette, but with the report's typography and card rhythm.

- [ ] **Step 1: Verify `--font-mono` var exists.** Open `src/web/index.css` or `src/web/styles.css`. The `--font-mono` variable should already reference JetBrains Mono. If not present:

```css
--font-mono: 'JetBrains Mono', 'Menlo', 'Consolas', monospace;
```

And reference from `font-mono` Tailwind utility (Tailwind v3 picks up CSS vars via `theme('fontFamily.mono')` if configured; if not, add `.font-mono { font-family: var(--font-mono); }` as a fallback).

- [ ] **Step 2: Scale up the H1 in LiveGradePage.tsx.** Change:
```tsx
<h1 className="text-2xl text-[var(--color-fg)] mt-1">{gradeMeta.domain}</h1>
```
to:
```tsx
<h1 className="text-3xl text-[var(--color-fg)] mt-1 font-mono">{gradeMeta.domain}</h1>
```

- [ ] **Step 3: Add section-divider treatment.** Find the "probes" section header in LiveGradePage.tsx:
```tsx
<div className="border-t border-[var(--color-line)] pt-4 mt-6">
  <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase mb-2">probes</div>
```
Replace with:
```tsx
<div className="border-t border-[var(--color-line)] pt-6 mt-8">
  <h2 className="text-lg text-[var(--color-fg)] mb-3 pb-2 border-b border-[var(--color-line)]">Probes</h2>
```

- [ ] **Step 4: Monospace the GradeLetter number.** In `src/web/components/GradeLetter.tsx`:

```tsx
export function GradeLetter(props: GradeLetterProps): JSX.Element {
  return (
    <div className="flex items-baseline gap-4">
      <div className="text-6xl font-mono font-bold text-[var(--color-brand)]">{props.letter}</div>
      <div className="text-xl font-mono text-[var(--color-fg-dim)]">{props.overall}/100</div>
    </div>
  )
}
```

- [ ] **Step 5: HowWeGradeCard — match section heading treatment.** Change the heading to mirror the new h2 pattern:

Find:
```tsx
<h2 className="text-sm tracking-wider text-[var(--color-fg-muted)] uppercase mb-3">
  How we grade
</h2>
```

Replace with:
```tsx
<h2 className="text-lg text-[var(--color-fg)] mb-3 pb-2 border-b border-[var(--color-line)]">
  How we grade
</h2>
```

- [ ] **Step 6: Verify CategoryTile's font-mono from Task 2 is applied.** `font-mono` should be on both the letter and the score. If not, add it.

- [ ] **Step 7: Run full test suite + typecheck.** Expect test files to mostly pass (no assertion on classNames); any snapshot will need updating. If HowWeGradeCard test asserts on specific Tailwind utility classes, relax to text-matching.

- [ ] **Step 8: Commit:**
```
git add src/web/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): hybrid styling — mono numbers + report typography scale"
```

---

## Self-review

**Spec coverage:**
- P14-1 letter grade on tiles → Task 2 ✓
- P14-2 4-phase generating state → Tasks 3, 4, 5 ✓
- P14-3 paid preview teaser → Task 6 ✓
- P14-4 hybrid styling → Task 7 ✓
- P14-5 scoreToLetter shared → Task 1 ✓
- P14-6 probe counter → Tasks 3, 4 ✓
- P14-7 templated sample recs → Task 6 ✓
- P14-8 no schema/endpoint changes → no DB or API task in the plan ✓

**Placeholder scan:** no TBD / "similar to Task N".

**Type consistency:**
- `scoreToLetter` signature — declared Task 1, consumed Task 2.
- `GradeState.reportProbeCount: number` — declared Task 3, consumed Task 4.
- `ReportProgress` props `{ paidStatus, reportProbeCount }` — declared Task 4, consumed Task 5 call site.
- `PaidReportPreview` props `{ domain, letter, overall }` — declared Task 6.
