import React from 'react'
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
        // Never leak raw provider diagnostics (HTTP status, API messages,
        // stack traces) to users. Show a generic chip; details stay server-side
        // in probe.metadata.error for debugging.
        <span className="text-[var(--color-warn)]" title="This probe could not be run">· failed</span>
      )}
    </div>
  )
}
