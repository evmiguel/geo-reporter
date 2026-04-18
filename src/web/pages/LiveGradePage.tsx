import React from 'react'
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
