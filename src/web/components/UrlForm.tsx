import React, { useCallback, useState, type FormEvent } from 'react'
import { Spinner } from './Spinner.tsx'
import { Turnstile } from './Turnstile.tsx'

export interface UrlFormProps {
  onSubmit: (url: string, turnstileToken?: string) => void
  pending: boolean
  errorMessage?: string
}

export function UrlForm(props: UrlFormProps): JSX.Element {
  const [value, setValue] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string>('')
  const onToken = useCallback((t: string) => setTurnstileToken(t), [])

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    // Empty token is meaningful: either the dev bypass (no site key) or the
    // widget hasn't resolved yet. The API layer passes undefined instead of ''
    // so the server can distinguish "not sent" from "sent empty".
    const token = turnstileToken.length > 0 ? turnstileToken : undefined
    props.onSubmit(trimmed, token)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://..."
          aria-label="Site URL to grade"
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:border-[var(--color-brand)]"
          disabled={props.pending}
        />
        <button
          type="submit"
          disabled={props.pending}
          aria-busy={props.pending}
          className="bg-[var(--color-brand)] text-[var(--color-on-brand)] px-4 py-2 font-semibold disabled:opacity-50"
        >
          {props.pending ? (<><Spinner className="mr-2" /> grading…</>) : 'grade'}
        </button>
      </div>
      <Turnstile onToken={onToken} />
      {props.errorMessage !== undefined && (
        <div className="text-[var(--color-warn)] text-xs">{props.errorMessage}</div>
      )}
    </form>
  )
}
