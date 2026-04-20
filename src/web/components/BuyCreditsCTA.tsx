import React, { useState } from 'react'
import { postBillingBuyCredits } from '../lib/api.ts'
import { Spinner } from './Spinner.tsx'

export function BuyCreditsCTA(): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick(): Promise<void> {
    setPending(true); setError(null)
    const result = await postBillingBuyCredits()
    if (result.ok) {
      window.location.assign(result.url)
      return
    }
    setPending(false)
    if (result.kind === 'must_verify_email') { setError('Verify your email first.'); return }
    if (result.kind === 'unavailable') { setError('Unavailable right now.'); return }
    setError('Something went wrong. Try again?')
  }

  return (
    <div className="mt-6 border border-[var(--color-good)] p-4">
      <div className="text-sm text-[var(--color-fg)] mb-1 font-semibold">
        Save 85% — 10 reports for $29
      </div>
      <div className="text-xs text-[var(--color-fg-muted)] mb-3">
        Credits never expire. Full 4-provider reports, same as the one-off.
      </div>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={pending}
        aria-busy={pending}
        className="bg-[var(--color-good)] text-[var(--color-on-brand)] px-4 py-2 font-semibold disabled:opacity-50"
      >
        {pending ? (<><Spinner className="mr-2" /> Loading…</>) : 'Get credits'}
      </button>
      {error !== null && <div className="text-xs text-[var(--color-warn)] mt-2">{error}</div>}
    </div>
  )
}
