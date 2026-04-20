import React from 'react'
import type { Phase } from '../lib/types.ts'

export interface StatusBarProps {
  phase: Phase
  scraped: { rendered: boolean; textLength: number } | null
}

const STEPS: { key: Phase; label: string }[] = [
  { key: 'queued', label: 'queued' },
  { key: 'running', label: 'running' },
  { key: 'scraped', label: 'analyzed' },
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
