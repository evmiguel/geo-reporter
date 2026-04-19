import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCreateGrade } from '../hooks/useCreateGrade.ts'
import { UrlForm } from '../components/UrlForm.tsx'
import { Toast } from '../components/Toast.tsx'

export function LandingPage(): JSX.Element {
  const { create, pending, error } = useCreateGrade()
  const [params, setParams] = useSearchParams()
  const [verifiedToast, setVerifiedToast] = useState<boolean>(params.get('verified') === '1')
  const [authError] = useState<string | null>(params.get('auth_error'))

  useEffect(() => {
    if (params.get('verified') !== null || params.get('auth_error') !== null) {
      const next = new URLSearchParams(params)
      next.delete('verified')
      next.delete('auth_error')
      setParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">landing</div>
      <h1 className="text-3xl mt-2 mb-2 text-[var(--color-fg)]">How well do LLMs know your site?</h1>
      <p className="text-[var(--color-fg-dim)] mb-8">
        We scrape your page, ask four LLMs about you, and score the results across six categories.
      </p>

      {authError !== null && (
        <div className="bg-[var(--color-bg-elevated)] border border-[var(--color-brand)] text-[var(--color-fg)] px-4 py-3 mb-6 flex items-center justify-between">
          <span>Your sign-in link didn't work or expired.</span>
          <a href="/email" className="text-[var(--color-brand)] underline text-sm">Request a new link →</a>
        </div>
      )}

      <UrlForm
        onSubmit={(url) => { void create(url) }}
        pending={pending}
        {...(error !== null ? { errorMessage: error } : {})}
      />

      {verifiedToast && (
        <Toast
          message="You're in — 10 more grades in this 24h window."
          onDismiss={() => setVerifiedToast(false)}
        />
      )}
    </div>
  )
}
