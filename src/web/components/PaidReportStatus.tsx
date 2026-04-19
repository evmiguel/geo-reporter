import React from 'react'
import type { PaidStatus } from '../lib/types.ts'

interface PaidReportStatusProps {
  status: Exclude<PaidStatus, 'none'>
  reportId: string | null
  reportToken: string | null
  error: string | null
}

export function PaidReportStatus({ status, reportId, reportToken, error }: PaidReportStatusProps): JSX.Element {
  if (status === 'checking_out' || status === 'generating') {
    return (
      <div className="mt-6 border border-[var(--color-brand)] p-4">
        <div className="text-sm text-[var(--color-fg)] mb-1">
          Payment received — your paid report is being generated.
        </div>
        <div className="text-xs text-[var(--color-fg-muted)]">This usually takes 30-60 seconds.</div>
      </div>
    )
  }
  if (status === 'ready' && reportId && reportToken) {
    return (
      <div className="mt-6 border border-[var(--color-good)] p-4">
        <div className="text-sm text-[var(--color-fg)] mb-3">Your paid report is ready.</div>
        <a
          href={`/report/${reportId}?t=${reportToken}`}
          className="bg-[var(--color-good)] text-[var(--color-bg)] px-4 py-2 font-semibold"
        >
          View your report →
        </a>
        <div className="text-xs text-[var(--color-fg-muted)] mt-2">
          Full report rendering lands in Plan 9.
        </div>
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className="mt-6 border border-[var(--color-warn)] p-4">
        <div className="text-sm text-[var(--color-fg)] mb-1">
          Something went wrong generating your report.
        </div>
        <div className="text-xs text-[var(--color-fg-muted)]">
          {error ?? "We've been notified and will refund your payment within 24h."}
        </div>
      </div>
    )
  }
  return <></>
}
