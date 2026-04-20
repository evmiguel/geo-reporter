# Plan 14 — Preview polish + report-style alignment

**Date:** 2026-04-20
**Status:** Design
**Author:** Claude + Erika

## 1. Problem

Live grade page doesn't sell the paid report. Four gaps:

1. **Category tiles show only a score.** A 78 tells you nothing if you don't know the scale. Letter grade (A/B/C/D/F) is the universal shortcut.
2. **"Generating report" is one pulsing dot** — no signal that anything is happening, no progress. Users clicking redeem wonder if the money was eaten.
3. **No preview of what's behind the paywall.** Buyer has to imagine what "the full report" contains. Conversion killer.
4. **Live page and the report look like different apps.** Live page is dark/terminal aesthetic, report is cream/document aesthetic. Continuity is weak.

## 2. Decisions

| ID | Decision |
|----|----------|
| P14-1 | **Letter grade appears on every category tile** — mono letter above the numeric score. Colored by score band (A/B green, C warn, D/F dim). |
| P14-2 | **"Generating report" becomes a 4-phase checklist** driven by SSE events — Scraping → Running blind probes (live counter) → Writing recommendations → Rendering. Each phase shows pending / in-progress / done states with a spinner on the active phase. |
| P14-3 | **Paid preview teaser card** between the scorecard grid and the BuyReportButton. Mini cover (domain + letter + overall) on top, then 1–2 sample recommendation cards with the "how" section blurred + lock icon overlay + CTA text "Unlock the full report — 4 LLM providers, 5–8 recommendations". |
| P14-4 | **Hybrid styling alignment** — keep the dark theme (brand identity, accessibility), adopt from the report: mono typeface for numbers, typography scale (h1 32px, h2 20px with section border, h3 16px), 1px-border card treatment, tighter spacing rhythm. Skips: cream background, serif prose, full visual flip. Easier to implement and doesn't risk regressions across other pages. |
| P14-5 | **New shared helpers.** `src/scoring/letter.ts` exports `scoreToLetter(score: number | null)` (returns `A | B | C | D | F | null`). `GradeLetter` and the new `CategoryTile` letter both use it. One source of truth for the 90/80/70/60 cutoffs. |
| P14-6 | **Live probe counter during generation.** Count of `report.probe.completed` events received vs total probers × categories (default: 2 providers × 3 delta categories = 6 for paid). Displays "Running blind probes (3/6)". |
| P14-7 | **Preview card content is static / templated, not real probe data.** Users haven't paid — we don't compute or reveal any real recommendations. The sample cards show placeholder copy that describes shape (title / rationale / impact bar) without giving specifics. |
| P14-8 | **No schema changes, no new endpoints.** Everything is frontend + existing SSE. |

## 3. Architecture

### 3.1 `src/scoring/letter.ts` — shared A-F mapping

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

Used by `GradeLetter.tsx` (which today accepts letter as a prop from the server), and by `CategoryTile.tsx` (new per-tile letter).

### 3.2 `CategoryTile.tsx` — letter grade

New layout:
```
DISCOVERABILITY · 30%
B            78
```

Letter is mono, sized so it anchors the tile visually; score stays on the right in mono. Both color-matched by score band. When null: letter omitted; score area shows `—` and "unscored" caption as today.

### 3.3 `ReportProgress.tsx` — 4-phase generating status

Replaces `BuyReportButton`'s `mode === 'generating'` render and `PaidReportStatus`'s `generating`/`checking_out` branch. Same component, rendered from LiveGradePage when `paidStatus !== 'none' && paidStatus !== 'ready'`.

Phase detection:
| Phase | Started when | Completed when |
|-------|--------------|----------------|
| Checking payment | `paidStatus === 'checking_out'` | `report.started` received |
| Running blind probes | `report.started` received | any `report.recommendations.started` OR all probes done |
| Writing recommendations | `report.recommendations.started` | `report.recommendations.completed` |
| Rendering your report | `report.recommendations.completed` | `report.done` |

Probe counter: count of `report.probe.completed` events since `report.started`. Total = `probers × 3` (delta categories are recognition/citation/discoverability when not already done — worker hard-codes this). Display only the numerator when total is fuzzy ("Running blind probe 3…").

Reducer exposes a new `reportProbeCount: number` field (resets on `report.started`, increments on `report.probe.completed`). No other state tracking needed — phase is derived from existing `paidStatus` + reducer signals.

### 3.4 `PaidReportPreview.tsx` — teaser card

Visual structure (dark-themed, report-card aesthetic):

```
┌─────────────────────────────────────────┐
│ FULL REPORT PREVIEW                     │
│                                         │
│ stripe.com      B · 87/100              │
│ ────────────────────────────            │
│                                         │
│ Recommendation #1 · accuracy            │
│ Publish canonical pricing page          │
│ LLMs invented pricing details. [blur]   │
│ ━━━━━━━━━━━━━━━━━━━━━  IMPACT high     │
│ ▓▓▓▓▓                   EFFORT low     │
│                                         │
│ Recommendation #2 · discoverability     │
│ [blur ... ]                             │
│                                         │
│        🔒  Unlock the full report       │
│        4 LLM providers · 5-8 recs · PDF │
└─────────────────────────────────────────┘
```

- Mini cover on top uses real data (the user's own domain + letter).
- Rec cards use static templated copy (e.g., "Publish canonical pricing page" / "Add llms.txt" — generic enough to apply to most sites).
- Lock overlay sits at bottom, echoing the unlock CTA copy. Clicking it scrolls to BuyReportButton (same page).
- Mounted when `state.phase === 'done' && effectivePaidStatus === 'none'` (same gate as `BuyReportButton`).

### 3.5 Hybrid styling alignment

Scope:
- `src/web/index.css` (or equivalent global sheet): add fallback mono font stack via `--font-mono` CSS var (already exists — verify). Apply to all numbers + monospace elements throughout.
- Typography scale adjustments in `LiveGradePage.tsx`:
  - H1 (domain) → `text-3xl` (was `text-2xl`)
  - Section labels (uppercase eyebrow) → keep, but consistent across page
  - Add a 1px bottom border on major section transitions (matches report h2 treatment)
- `CategoryTile.tsx`, `ReportProgress.tsx`, `PaidReportPreview.tsx` get consistent card treatment: `border border-[var(--color-line)]`, no fill change unless contextual (e.g., bg-elevated for active tile).
- No color palette flip. No serif body. No cream anything.

Non-goals: redesigning Header/Footer/Landing, touching AccountPage, PDF styling.

## 4. Testing

Unit:
- `scoreToLetter`: 90/80/70/60 boundary tests + null + > 100 + < 0 clamp behavior (decision: clamp to F for negative, A for >100 — no error).
- `CategoryTile`: renders letter when score is numeric; omits letter when null; letter color tracks score band.
- `ReportProgress`: phase detection logic — (a) checking_out → phase 1 active; (b) report.started → phase 1 done, phase 2 active; (c) recommendations.started → phase 3 active; (d) probe counter increments on report.probe.completed.
- `PaidReportPreview`: renders the mini cover with the graded domain + letter; renders 2 sample rec cards; clicking lock overlay scrolls into view (or just emits a callback).

Integration: none needed — all frontend.

## 5. Files touched

Create:
- `src/scoring/letter.ts`
- `src/web/components/ReportProgress.tsx`
- `src/web/components/PaidReportPreview.tsx`
- `tests/unit/scoring/letter.test.ts`
- `tests/unit/web/components/ReportProgress.test.tsx`
- `tests/unit/web/components/PaidReportPreview.test.tsx`

Modify:
- `src/web/components/CategoryTile.tsx`
- `src/web/components/GradeLetter.tsx` (optional — derive letter when not passed)
- `src/web/components/PaidReportStatus.tsx` (defer generating/checking_out to `ReportProgress`; keep ready/failed branches)
- `src/web/components/BuyReportButton.tsx` (remove inline `generating` render; rely on page-level `ReportProgress`)
- `src/web/pages/LiveGradePage.tsx` (mount `PaidReportPreview` + `ReportProgress`, typography tweaks)
- `src/web/lib/grade-reducer.ts` (add `reportProbeCount`, reset on `report.started`, increment on `report.probe.completed`)
- `src/web/lib/types.ts` (extend `GradeState` with `reportProbeCount: number`)
- `tests/unit/web/components/CategoryTile.test.tsx`
- `tests/unit/web/components/BuyReportButton.test.tsx` (remove the 2 "Generating your full report" assertions — the render moved to page level; verify the button clears out / page shows ReportProgress instead)
- `tests/unit/web/lib/grade-reducer.test.ts` (reportProbeCount cases)

## 6. Risks

- **BuyReportButton generating-state tests will break** — the render moved. Rewrite those two tests to assert on `ReportProgress` behavior or that `BuyReportButton` hides itself when `paidStatus !== 'none'`.
- **Preview card looks fake** — if the sample rec copy is too generic, it undermines credibility. Two guardrails: (a) pick realistic recommendations that apply to most websites, (b) explicitly label the card "preview" / "sample" so no one thinks these are their actual findings.
- **Phase detection races** — SSE events can arrive out of order or be dropped. The component should be robust: always show the current phase based on latest signal, never stall if intermediate events are missing. Key invariant: `paidStatus === 'ready'` unmounts `ReportProgress` regardless of what phase the UI thinks it's in.
- **Hybrid styling might still feel incoherent** — if the typography nudges aren't enough, we can revisit with a follow-up plan for deeper alignment. Not committing to a full flip here.
