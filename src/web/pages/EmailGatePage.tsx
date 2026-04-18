import React, { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

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
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (email.trim().length === 0) return
    setPending(true)
    setMessage(null)
    const res = await fetch('/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: email.trim() }),
    }).catch(() => null)
    setPending(false)
    if (res === null) {
      setMessage('Network error. Try again.')
      return
    }
    if (res.status === 404) {
      setMessage('Magic-link email is coming soon (Plan 7). For now, swap cookies or wait.')
      return
    }
    if (!res.ok) {
      setMessage(`Request failed (${res.status}).`)
      return
    }
    setMessage('Check your email for a sign-in link.')
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">paywall</div>
      <h1 className="text-2xl mt-2 mb-2 text-[var(--color-fg)]">You've hit your free limit</h1>
      <p className="text-[var(--color-fg-dim)] mb-4">
        3 grades per 24 hours for anonymous visitors. Verify your email and we'll unlock{' '}
        <span className="text-[var(--color-good)]">10 more</span>.
      </p>
      {retrySeconds > 0 && (
        <div className="text-xs text-[var(--color-fg-muted)] mb-4">
          Or come back in <span className="text-[var(--color-fg-dim)]">{formatRetry(retrySeconds)}</span>.
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-brand)]"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={pending}
          className="bg-[var(--color-brand)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
        >
          {pending ? '...' : 'send link'}
        </button>
      </form>

      {message !== null && (
        <div className="text-xs text-[var(--color-fg-dim)] mt-4">{message}</div>
      )}

      <div className="mt-12">
        <Link to="/" className="text-[var(--color-brand)] text-xs">← back to home</Link>
      </div>
    </div>
  )
}
