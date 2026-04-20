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
  const numberClass = hasScore
    ? `text-2xl font-mono ${scoreColor(score)}`
    : 'text-2xl font-mono text-[var(--color-fg-dim)]'

  return (
    <div className="border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-3">
      <div className="text-[10px] tracking-wider text-[var(--color-fg-muted)] uppercase">
        {category} · {weight}%
      </div>
      <div className="flex items-baseline justify-between mt-1">
        {letter !== null && hasScore ? (
          <div className={`text-2xl font-mono ${scoreColor(score)}`}>{letter}</div>
        ) : <div />}
        <div data-score className={numberClass}>
          {hasScore ? score : isDoneWithNull ? '—' : '...'}
        </div>
      </div>
      {isDoneWithNull && (
        <div className="text-[10px] text-[var(--color-fg-muted)] mt-1">unscored</div>
      )}
    </div>
  )
}
