import React, { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { postAuthMagic } from '../lib/api.ts'

function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const leftoverMinutes = minutes % 60
  return `${hours}h ${leftoverMinutes}m`
}

export function EmailGatePage(): JSX.Element {
  const [params] = useSearchParams()
  const retrySeconds = Number(params.get('retry') ?? '0')
  const next = params.get('next') ?? undefined
  const isRateCapped = retrySeconds > 0
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldownUntil, setCooldownUntil] = useState<number>(0)
  const [now, setNow] = useState<number>(Date.now())

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [])

  const cooldownSecs = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  async function submit(): Promise<void> {
    if (email.trim().length === 0) return
    setPending(true); setError(null)
    const result = await postAuthMagic(email.trim(), next)
    setPending(false)
    if (result.ok) {
      setSent(true)
      setCooldownUntil(Date.now() + 60_000)
      return
    }
    if (result.error === 'invalid_email') { setError("That doesn't look like a valid email."); return }
    if (result.error === 'rate_limit_email') {
      setError(`Please wait ${result.retryAfter ?? 60}s before resending.`)
      if (result.retryAfter !== undefined) setCooldownUntil(Date.now() + result.retryAfter * 1000)
      return
    }
    setError(`Too many requests from this connection. Try again in ${Math.ceil((result.retryAfter ?? 600) / 60)}m.`)
    if (result.retryAfter !== undefined) setCooldownUntil(Date.now() + result.retryAfter * 1000)
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    await submit()
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">
        {isRateCapped ? 'paywall' : 'sign in'}
      </div>
      <h1 className="text-2xl mt-2 mb-2 text-[var(--color-fg)]">
        {isRateCapped ? "You've hit your free limit" : 'Sign in with your email'}
      </h1>
      <p className="text-[var(--color-fg-dim)] mb-4">
        {isRateCapped ? (
          <>
            3 grades per 24 hours, then you're tapped out. Verify your email to buy{' '}
            <span className="text-[var(--color-good)]">10 reports for $29</span> — each credit grades a
            site and unlocks a full 4-provider paid report.
          </>
        ) : (
          <>
            We'll email you a one-click sign-in link — no password. Verified accounts can buy credits
            (<span className="text-[var(--color-good)]">10 reports for $29</span>) and access paid
            reports from any device.
          </>
        )}
      </p>
      {isRateCapped && (
        <div className="text-xs text-[var(--color-fg-muted)] mb-4">
          Or come back in <span className="text-[var(--color-fg-dim)]">{formatRetry(retrySeconds)}</span>.
        </div>
      )}

      {!sent ? (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Email address"
            className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:border-[var(--color-brand)]"
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending}
            className="bg-[var(--color-brand)] text-[var(--color-on-brand)] px-4 py-2 font-semibold disabled:opacity-50"
          >
            {pending ? '...' : 'send link'}
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="text-sm text-[var(--color-good)]">Check your email for a sign-in link.</div>
          <button
            type="button"
            onClick={() => { void submit() }}
            disabled={cooldownSecs > 0 || pending}
            className="bg-[var(--color-bg-elevated)] border border-[var(--color-line)] text-[var(--color-fg)] px-4 py-2 text-sm disabled:opacity-50"
          >
            {cooldownSecs > 0 ? `Resend in ${cooldownSecs}s` : 'Resend link'}
          </button>
        </div>
      )}

      {error !== null && (
        <div className="text-xs text-[var(--color-brand)] mt-3">{error}</div>
      )}

      <div className="mt-12">
        <Link to="/" className="text-[var(--color-brand)] text-xs">← back to home</Link>
      </div>
    </div>
  )
}
