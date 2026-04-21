import React, { useEffect, useState } from 'react'
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom'
import { useCreateGrade } from '../hooks/useCreateGrade.ts'
import { useAuth } from '../hooks/useAuth.ts'
import { UrlForm } from '../components/UrlForm.tsx'
import { Toast } from '../components/Toast.tsx'
import { BuyCreditsCTA } from '../components/BuyCreditsCTA.tsx'
import { CreditsPurchasedToast } from '../components/CreditsPurchasedToast.tsx'
import { ContactForm } from '../components/ContactForm.tsx'

interface PostSubmitFailureState { message: string }

export function LandingPage(): JSX.Element {
  const { create, pending, error: hookError } = useCreateGrade()
  const { verified, credits, refresh } = useAuth()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [verifiedToast, setVerifiedToast] = useState<boolean>(params.get('verified') === '1')
  const [authError] = useState<string | null>(params.get('auth_error'))
  const [creditsToast, setCreditsToast] = useState<'purchased' | 'canceled' | null>(
    params.get('credits') === 'purchased' ? 'purchased' :
    params.get('credits') === 'canceled' ? 'canceled' :
    null,
  )
  const [deletedToast, setDeletedToast] = useState<boolean>(params.get('deleted') === '1')
  // Slow-failure redirect from LiveGradePage: shows the same inline-error
  // UX as a fast (peek-caught) failure, just reached via a different path.
  // Clear out of history.state on mount so a reload doesn't re-fire it.
  const [redirectError, setRedirectError] = useState<string | null>(() => {
    const state = location.state as { postSubmitFailure?: PostSubmitFailureState } | null
    return state?.postSubmitFailure?.message ?? null
  })

  useEffect(() => {
    const hasAny = ['verified', 'auth_error', 'credits', 'deleted'].some((k) => params.get(k) !== null)
    if (hasAny) {
      const next = new URLSearchParams(params)
      next.delete('verified')
      next.delete('auth_error')
      next.delete('credits')
      next.delete('deleted')
      setParams(next, { replace: true })
    }
    if (params.get('credits') === 'purchased') void refresh()
    if (params.get('deleted') === '1') void refresh()
    // Clear the post-submit-failure location state so reload doesn't resurrect
    // the error. We kept the message in component state above, so it still
    // renders this pass.
    const s = location.state as { postSubmitFailure?: PostSubmitFailureState } | null
    if (s?.postSubmitFailure) {
      navigate(location.pathname, { replace: true, state: {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Hook clears its own error at the start of every submit; mirror that
  // for the redirect error so a fresh submit wipes the banner.
  const error = hookError ?? redirectError
  function handleSubmit(url: string, token?: string): void {
    setRedirectError(null)
    void create(url, token)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">landing</div>
      <h1 className="text-3xl mt-2 mb-2 text-[var(--color-fg)]">How well do LLMs know your site?</h1>
      <p className="text-[var(--color-fg-dim)] mb-8">
        We analyze your page, ask four LLMs about you, and score the results across six categories.
      </p>

      {authError !== null && (
        <div className="bg-[var(--color-bg-elevated)] border border-[var(--color-brand)] text-[var(--color-fg)] px-4 py-3 mb-6 flex items-center justify-between">
          <span>Your sign-in link didn't work or expired.</span>
          <a href="/email" className="text-[var(--color-brand)] underline text-sm">Request a new link →</a>
        </div>
      )}

      <UrlForm
        onSubmit={handleSubmit}
        pending={pending}
        {...(error !== null ? { errorMessage: error } : {})}
      />

      {verified && credits === 0 && <BuyCreditsCTA />}

      {verifiedToast && (
        <Toast
          message="You're in — credits unlock more grades per day."
          onDismiss={() => setVerifiedToast(false)}
        />
      )}

      {creditsToast !== null && (
        <CreditsPurchasedToast kind={creditsToast} onDismiss={() => setCreditsToast(null)} />
      )}

      {deletedToast && (
        <Toast
          message="Account deleted."
          onDismiss={() => setDeletedToast(false)}
        />
      )}

      <ContactForm />
    </div>
  )
}
