import React, { useState } from 'react'
import { postBillingCheckout, postBillingRedeemCredit } from '../lib/api.ts'
import { useAuth } from '../hooks/useAuth.ts'

interface BuyReportButtonProps {
  gradeId: string
  onAlreadyPaid: (reportId: string) => void
}

export function BuyReportButton({ gradeId, onAlreadyPaid }: BuyReportButtonProps): JSX.Element {
  const { credits, refresh } = useAuth()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasCredits = credits > 0

  async function handleClick(): Promise<void> {
    setPending(true); setError(null)
    if (hasCredits) {
      const result = await postBillingRedeemCredit(gradeId)
      setPending(false)
      if (result.ok) {
        await refresh()
        return
      }
      if (result.kind === 'already_paid') { onAlreadyPaid(gradeId); return }
      if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
      if (result.kind === 'no_credits') { setError('No credits available. Buy a pack below.'); return }
      if (result.kind === 'must_verify_email') { setError('Verify your email first.'); return }
      if (result.kind === 'unavailable') { setError('Checkout is temporarily unavailable.'); return }
      setError('Something went wrong. Try again?')
      return
    }
    const result = await postBillingCheckout(gradeId)
    if (result.ok) { window.location.assign(result.url); return }
    setPending(false)
    if (result.kind === 'already_paid') { onAlreadyPaid(result.reportId); return }
    if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
    if (result.kind === 'unavailable') { setError('Checkout is temporarily unavailable.'); return }
    setError('Something went wrong. Try again?')
  }

  const label = hasCredits
    ? `Redeem 1 credit (${credits - 1} left)`
    : 'Get the full report — $19'

  return (
    <div className="mt-6 border border-[var(--color-brand)] p-4">
      <div className="text-sm text-[var(--color-fg)] mb-3">
        Unlock the full report — 4 LLM providers, 5-8 concrete recommendations, HTML + PDF.
      </div>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={pending}
        className="bg-[var(--color-brand)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
      >
        {pending ? '...' : label}
      </button>
      {error !== null && <div className="text-xs text-[var(--color-warn)] mt-2">{error}</div>}
    </div>
  )
}
