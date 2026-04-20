import React from 'react'
import type { PaidStatus, ReportPhase } from '../lib/types.ts'
import { Spinner } from './Spinner.tsx'

interface Props {
  paidStatus: PaidStatus
  reportPhase: ReportPhase
  reportProbeCount: number
}

interface Phase {
  key: 'checking' | 'probing' | 'writing' | 'rendering'
  label: string
  detail?: string
  status: 'done' | 'active' | 'pending'
}

function derivePhases(
  paidStatus: PaidStatus,
  reportPhase: ReportPhase,
  probeCount: number,
): Phase[] {
  // Checking is only active during the Stripe round-trip. Once paidStatus
  // flips to generating, checking is always done.
  const checking: Phase['status'] = paidStatus === 'checking_out' ? 'active' : 'done'

  // Probing / writing / rendering status is driven by the SSE sub-phase.
  // If paidStatus === 'checking_out', they're all pending.
  // If paidStatus === 'generating', whichever phase matches reportPhase is
  // active; earlier phases are done; later phases are pending.
  const ORDER: Phase['key'][] = ['probing', 'writing', 'rendering']
  const activeIdx = reportPhase === null ? -1 : ORDER.indexOf(reportPhase)

  function subStatus(key: Phase['key']): Phase['status'] {
    if (paidStatus === 'checking_out') return 'pending'
    if (activeIdx === -1) return key === 'probing' ? 'active' : 'pending'
    const idx = ORDER.indexOf(key)
    if (idx < activeIdx) return 'done'
    if (idx === activeIdx) return 'active'
    return 'pending'
  }

  const probingPhase: Phase = {
    key: 'probing',
    label: 'Running blind probes',
    status: subStatus('probing'),
  }
  if (probingPhase.status === 'active' && probeCount > 0) {
    probingPhase.detail = `probe ${probeCount}`
  }

  return [
    { key: 'checking', label: 'Checking payment', status: checking },
    probingPhase,
    { key: 'writing', label: 'Writing recommendations', status: subStatus('writing') },
    { key: 'rendering', label: 'Rendering your report', status: subStatus('rendering') },
  ]
}

export function ReportProgress({ paidStatus, reportPhase, reportProbeCount }: Props): JSX.Element | null {
  if (paidStatus === 'none' || paidStatus === 'ready' || paidStatus === 'failed') {
    return null
  }
  const phases = derivePhases(paidStatus, reportPhase, reportProbeCount)
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
