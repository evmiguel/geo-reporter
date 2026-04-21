import React from 'react'
import { usePaidReportStatus } from '../hooks/usePaidReportStatus.ts'

interface PaidReportStatusProps {
  status: 'ready' | 'failed' | 'refunded'
  reportId: string | null
  reportToken: string | null
  error: string | null
  refundKind: 'credit' | 'stripe' | null
}

export function PaidReportStatus({ status, reportId, reportToken, error, refundKind }: PaidReportStatusProps): JSX.Element {
  const { pdf } = usePaidReportStatus(
    status === 'ready' ? reportId : null,
    status === 'ready' ? reportToken : null,
  )

  if (status === 'refunded') {
    return (
      <div className="mt-6 border border-[var(--color-good)] p-4">
        <div className="text-sm text-[var(--color-fg)] mb-1">
          Refunded — the report couldn't be generated after three tries.
        </div>
        <div className="text-xs text-[var(--color-fg-muted)]">
          {refundKind === 'credit'
            ? "Your credit is back on your account. Try another URL whenever you're ready."
            : "Your $19 payment has been refunded to your card (takes 5–10 business days)."}
        </div>
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
            className="bg-[var(--color-good)] text-[var(--color-on-brand)] px-4 py-2 font-semibold"
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
