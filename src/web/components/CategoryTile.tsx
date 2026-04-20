import React from 'react'
import type { CategoryId, Phase } from '../lib/types.ts'
import { scoreToLetter, scoreBandClass, scoreBandBgClass } from '../../scoring/letter.ts'

export interface CategoryTileProps {
  category: CategoryId
  weight: number
  score: number | null
  phase: Phase
}

export function CategoryTile(props: CategoryTileProps): JSX.Element {
  const { category, weight, score, phase } = props
  const hasScore = score !== null
  const isDoneWithNull = !hasScore && phase === 'done'
  const letter = scoreToLetter(score)
  const textColor = scoreBandClass(score)
  const barColor = scoreBandBgClass(score)

  return (
    <div className="border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-3">
      <div className="text-[10px] tracking-wider text-[var(--color-fg-muted)] uppercase">
        {category} · {weight}%
      </div>
      <div className="flex items-baseline justify-between mt-1">
        {letter !== null && hasScore ? (
          <div className={`text-2xl font-mono ${textColor}`}>{letter}</div>
        ) : <div />}
        <div data-score className={`text-2xl font-mono ${textColor}`}>
          {hasScore ? score : isDoneWithNull ? '—' : '...'}
        </div>
      </div>
      {hasScore && (
        <div className="h-1 bg-[var(--color-line)] mt-2 overflow-hidden">
          <div
            className={`h-full ${barColor} transition-[width] duration-700 ease-out`}
            style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
          />
        </div>
      )}
      {isDoneWithNull && (
        <div className="text-[10px] text-[var(--color-fg-muted)] mt-1">unscored</div>
      )}
    </div>
  )
}
