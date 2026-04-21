import React, { useCallback, useState, type FormEvent } from 'react'
import { postContactMessage, type ContactCategory } from '../lib/api.ts'
import { Spinner } from './Spinner.tsx'
import { Turnstile, TURNSTILE_ENABLED } from './Turnstile.tsx'

export function ContactForm(): JSX.Element {
  const [email, setEmail] = useState('')
  const [category, setCategory] = useState<ContactCategory>('bug')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState('')
  const onToken = useCallback((t: string) => setTurnstileToken(t), [])

  const waitingForCaptcha = TURNSTILE_ENABLED && turnstileToken.length === 0

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (pending || waitingForCaptcha) return
    if (email.trim().length === 0 || body.trim().length < 10) {
      setError('Please fill in both fields (message at least 10 characters).')
      return
    }
    setPending(true); setError(null)
    const token = turnstileToken.length > 0 ? turnstileToken : undefined
    const result = await postContactMessage(email.trim(), category, body.trim(), token)
    setPending(false)
    if (result.ok) {
      setSent(true)
      setEmail('')
      setBody('')
      return
    }
    if (result.kind === 'rate_limited') {
      setError("You've sent the max messages for today. Try again tomorrow.")
      return
    }
    if (result.kind === 'captcha_failed') {
      setError("Couldn't verify you're human — please try again.")
      return
    }
    if (result.kind === 'invalid_body') {
      setError('Please check the email and message.')
      return
    }
    if (result.kind === 'send_failed') {
      setError("We couldn't send your message. Try again in a moment.")
      return
    }
    setError('Something went wrong. Try again?')
  }

  if (sent) {
    return (
      <section className="border-t border-[var(--color-line)] pt-8 mt-16">
        <h2 className="text-lg text-[var(--color-fg)] mb-3 pb-2 border-b border-[var(--color-line)]">Contact us</h2>
        <div className="text-sm text-[var(--color-good)]">Thanks — we'll reply to your email shortly.</div>
      </section>
    )
  }

  return (
    <section className="border-t border-[var(--color-line)] pt-8 mt-16">
      <h2 className="text-lg text-[var(--color-fg)] mb-3 pb-2 border-b border-[var(--color-line)]">Contact us</h2>
      <p className="text-sm text-[var(--color-fg-dim)] mb-4">
        Refund issue, bug, feature request, or anything else? Send us a note.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="contact-email" className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">
            Your email
          </label>
          <input
            id="contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            className="bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:border-[var(--color-brand)]"
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="contact-category" className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">
            What's this about?
          </label>
          <select
            id="contact-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as ContactCategory)}
            className="bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] focus:border-[var(--color-brand)]"
            disabled={pending}
          >
            <option value="refund">Refund issue</option>
            <option value="bug">Bug report</option>
            <option value="feature">Feature request</option>
            <option value="other">Something else</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="contact-body" className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">
            Message
          </label>
          <textarea
            id="contact-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Tell us what happened, what you were trying to do, or what you'd like to see."
            rows={5}
            className="bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:border-[var(--color-brand)] font-[inherit]"
            disabled={pending}
          />
        </div>
        <Turnstile onToken={onToken} />
        {waitingForCaptcha && (
          <div className="text-xs text-[var(--color-fg-muted)] flex items-center gap-2">
            <Spinner size={10} /> Verifying you're human…
          </div>
        )}
        {error !== null && <div className="text-xs text-[var(--color-warn)]">{error}</div>}
        <button
          type="submit"
          disabled={pending || waitingForCaptcha}
          aria-busy={pending}
          className="bg-[var(--color-brand)] text-[var(--color-on-brand)] px-4 py-2 font-semibold disabled:opacity-50 self-start"
        >
          {pending ? (<><Spinner className="mr-2" /> Sending…</>) : 'Send'}
        </button>
      </form>
    </section>
  )
}
