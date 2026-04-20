import React, { useCallback, useEffect, useState, type FormEvent } from 'react'
import { postBillingCheckout, postBillingRedeemCredit, postAuthMagic } from '../lib/api.ts'
import { useAuth } from '../hooks/useAuth.ts'
import { Spinner } from './Spinner.tsx'
import { Turnstile } from './Turnstile.tsx'

interface BuyReportButtonProps {
  gradeId: string
  onAlreadyPaid: (reportId: string) => void
}

type Mode = 'idle' | 'verify_email' | 'email_sent'

export function BuyReportButton({ gradeId, onAlreadyPaid }: BuyReportButtonProps): JSX.Element {
  const { credits, refresh } = useAuth()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('idle')
  const [email, setEmail] = useState('')
  const [cooldownUntil, setCooldownUntil] = useState<number>(0)
  const [now, setNow] = useState<number>(Date.now())
  const [turnstileToken, setTurnstileToken] = useState<string>('')
  const onToken = useCallback((t: string) => setTurnstileToken(t), [])

  const hasCredits = credits > 0

  useEffect(() => {
    if (mode !== 'email_sent') return
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [mode])

  const cooldownSecs = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  async function handleClick(): Promise<void> {
    setPending(true); setError(null)
    if (hasCredits) {
      const result = await postBillingRedeemCredit(gradeId)
      if (result.ok) {
        // Keep pending=true (don't clear). The page-level ReportProgress
        // takes over as soon as SSE 'report.started' flips paidStatus; at
        // that point LiveGradePage unmounts this button entirely via
        // isFreeTierDone. Clearing pending would give a ~500ms window
        // where the button re-enables and the user can click again.
        void refresh()
        return
      }
      setPending(false)
      if (result.kind === 'already_paid') { onAlreadyPaid(gradeId); return }
      if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
      if (result.kind === 'provider_outage') {
        setError('LLM provider outage during grading. Start a new grade to unlock.')
        return
      }
      if (result.kind === 'no_credits') { setError('No credits available. Buy a pack below.'); return }
      if (result.kind === 'must_verify_email') { setError('Verify your email first.'); return }
      if (result.kind === 'unavailable') { setError('Checkout is temporarily unavailable.'); return }
      setError('Something went wrong. Try again?')
      return
    }
    const result = await postBillingCheckout(gradeId)
    if (result.ok) {
      if (result.kind === 'checkout') { window.location.assign(result.url); return }
      // Server short-circuited via credit — same reasoning as above: keep
      // pending=true so the button stays disabled until SSE unmounts it.
      void refresh()
      return
    }
    setPending(false)
    if (result.kind === 'already_paid') { onAlreadyPaid(result.reportId); return }
    if (result.kind === 'grade_not_done') { setError('This grade is not done yet.'); return }
    if (result.kind === 'provider_outage') {
      setError('LLM provider outage during grading. Start a new grade to unlock.')
      return
    }
    if (result.kind === 'must_verify_email') { setMode('verify_email'); return }
    if (result.kind === 'rate_limited') {
      setError(`Too many checkout attempts. Try again in ${Math.ceil(result.retryAfter / 60)} min.`)
      return
    }
    if (result.kind === 'unavailable') { setError('Checkout is temporarily unavailable.'); return }
    setError('Something went wrong. Try again?')
  }

  async function submitEmail(): Promise<void> {
    if (email.trim().length === 0) return
    setPending(true); setError(null)
    // After they click the magic link in email, send them back to this grade
    // page so they can resume checkout in one more click (verified will be true).
    const token = turnstileToken.length > 0 ? turnstileToken : undefined
    const result = await postAuthMagic(email.trim(), `/g/${gradeId}`, token)
    setPending(false)
    if (result.ok) {
      setMode('email_sent')
      setCooldownUntil(Date.now() + 60_000)
      return
    }
    if (result.error === 'invalid_email') { setError("That doesn't look like a valid email."); return }
    if (result.error === 'captcha_failed') { setError("Couldn't verify you're human — please try again."); return }
    if (result.error === 'rate_limit_email') {
      setError(`Please wait ${result.retryAfter ?? 60}s before resending.`)
      if (result.retryAfter !== undefined) setCooldownUntil(Date.now() + result.retryAfter * 1000)
      return
    }
    setError(`Too many requests from this connection. Try again in ${Math.ceil((result.retryAfter ?? 600) / 60)}m.`)
    if (result.retryAfter !== undefined) setCooldownUntil(Date.now() + result.retryAfter * 1000)
  }

  function handleEmailSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    void submitEmail()
  }

  const label = hasCredits
    ? `Redeem 1 credit (${credits - 1} left)`
    : 'Get the full report — $19'

  if (mode === 'verify_email' || mode === 'email_sent') {
    return (
      <div className="mt-6 border border-[var(--color-brand)] p-4">
        <div className="text-sm text-[var(--color-fg)] mb-1">
          Verify your email to continue.
        </div>
        <div className="text-xs text-[var(--color-fg-muted)] mb-3">
          We need an email so your $19 report stays accessible if you switch devices or clear cookies.
        </div>
        {mode === 'verify_email' ? (
          <form onSubmit={handleEmailSubmit} className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email address for checkout"
                className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:border-[var(--color-brand)]"
                disabled={pending}
              />
              <button
                type="submit"
                disabled={pending}
                aria-busy={pending}
                className="bg-[var(--color-brand)] text-[var(--color-on-brand)] px-4 py-2 font-semibold disabled:opacity-50"
              >
                {pending ? (<><Spinner className="mr-2" /> Sending…</>) : 'send link'}
              </button>
            </div>
            <Turnstile onToken={onToken} />
          </form>
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-[var(--color-good)]">Check your email — click the link to verify, then continue checkout.</div>
            <button
              type="button"
              onClick={() => { void submitEmail() }}
              disabled={cooldownSecs > 0 || pending}
              className="bg-[var(--color-bg-elevated)] border border-[var(--color-line)] text-[var(--color-fg)] px-4 py-2 text-sm disabled:opacity-50"
            >
              {cooldownSecs > 0 ? `Resend in ${cooldownSecs}s` : 'Resend link'}
            </button>
          </div>
        )}
        {error !== null && <div className="text-xs text-[var(--color-warn)] mt-2">{error}</div>}
      </div>
    )
  }

  if (error !== null && error.startsWith('LLM provider outage')) {
    return (
      <div className="mt-6 border border-[var(--color-warn)] p-4">
        <div className="text-sm text-[var(--color-warn)] font-semibold mb-1">LLM provider outage</div>
        <div className="text-xs text-[var(--color-fg-dim)]">Start a new grade to unlock the full report.</div>
      </div>
    )
  }

  return (
    <div className="mt-6 border border-[var(--color-brand)] p-4">
      <div className="text-sm text-[var(--color-fg)] mb-3">
        Unlock the full report — 4 LLM providers, 5-8 concrete recommendations, HTML + PDF.
      </div>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={pending}
        aria-busy={pending}
        className="bg-[var(--color-brand)] text-[var(--color-on-brand)] px-4 py-2 font-semibold disabled:opacity-50"
      >
        {pending ? (<><Spinner className="mr-2" /> Processing…</>) : label}
      </button>
      {error !== null && <div className="text-xs text-[var(--color-warn)] mt-2">{error}</div>}
    </div>
  )
}
