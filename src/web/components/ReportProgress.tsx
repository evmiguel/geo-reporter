import React from 'react'
import type { PaidStatus } from '../lib/types.ts'
import { Spinner } from './Spinner.tsx'

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
  const checking: Phase['status'] = paidStatus === 'checking_out' ? 'active' : 'done'
  const probing: Phase['status'] =
    paidStatus === 'checking_out' ? 'pending' :
    paidStatus === 'generating' ? 'active' : 'done'
  const writing: Phase['status'] = 'pending'
  const rendering: Phase['status'] = 'pending'

  const probingPhase: Phase = {
    key: 'probing',
    label: 'Running blind probes',
    status: probing,
  }
  if (probing === 'active' && probeCount > 0) {
    probingPhase.detail = `probe ${probeCount}`
  }

  return [
    { key: 'checking', label: 'Checking payment', status: checking },
    probingPhase,
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
            <span className="w-4 h-4 flex items-center justify-center shrink-0 font-mono text-xs">
              {p.status === 'done' && <span className="text-[var(--color-good)]">✓</span>}
              {p.status === 'active' && (
                <Spinner size={14} className="text-[var(--color-brand)]" />
              )}
              {p.status === 'pending' && <span className="text-[var(--color-fg-muted)]">○</span>}
            </span>
            <span className={
              p.status === 'done' ? 'text-[var(--color-fg-dim)]' :
              p.status === 'active' ? 'text-[var(--color-fg)]' :
              'text-[var(--color-fg-muted)]'
            }>
              {p.label}
              {p.detail !== undefined && (
                <span className="text-[var(--color-fg-muted)] ml-2 font-mono text-xs">{p.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="text-xs text-[var(--color-fg-muted)] mt-3">Usually 30-60 seconds.</div>
    </div>
  )
}
