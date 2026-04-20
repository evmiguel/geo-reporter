import React from 'react'
import type { PaidStatus } from '../lib/types.ts'
import { usePaidReportStatus } from '../hooks/usePaidReportStatus.ts'

interface PaidReportStatusProps {
  status: Exclude<PaidStatus, 'none'>
  reportId: string | null
  reportToken: string | null
  error: string | null
}

export function PaidReportStatus({ status, reportId, reportToken, error }: PaidReportStatusProps): JSX.Element {
  const { pdf } = usePaidReportStatus(
    status === 'ready' ? reportId : null,
    status === 'ready' ? reportToken : null,
  )

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
        <div className="flex gap-2 items-center">
          <a
            href={`/report/${reportId}?t=${reportToken}`}
            className="bg-[var(--color-good)] text-[var(--color-bg)] px-4 py-2 font-semibold"
          >
            View report →
          </a>
          {pdf === 'ready' ? (
            <a
              href={`/report/${reportId}.pdf?t=${reportToken}`}
              className="border border-[var(--color-line)] text-[var(--color-fg)] px-4 py-2"
            >
              Download PDF
            </a>
          ) : pdf === 'failed' ? (
            <span className="text-xs text-[var(--color-fg-muted)]">PDF unavailable</span>
          ) : (
            <span className="text-xs text-[var(--color-fg-muted)]">PDF generating…</span>
          )}
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
