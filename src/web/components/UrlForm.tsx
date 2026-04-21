import React, { useCallback, useState, type FormEvent } from 'react'
import { Spinner } from './Spinner.tsx'
import { Turnstile, TURNSTILE_ENABLED } from './Turnstile.tsx'

export interface UrlFormProps {
  onSubmit: (url: string, turnstileToken?: string) => void
  pending: boolean
  errorMessage?: string
}

export function UrlForm(props: UrlFormProps): JSX.Element {
  const [value, setValue] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string>('')
  const onToken = useCallback((t: string) => setTurnstileToken(t), [])

  // When Turnstile is enabled, block submit until the widget produces a token.
  // Without this gate, the user can hit "grade" before the ~1-3s background
  // verification resolves, and the server rejects with captcha_failed.
  const waitingForCaptcha = TURNSTILE_ENABLED && turnstileToken.length === 0
  const disabled = props.pending || waitingForCaptcha

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    if (waitingForCaptcha) return
    const token = turnstileToken.length > 0 ? turnstileToken : undefined
    props.onSubmit(trimmed, token)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="example.com or https://..."
          aria-label="Site URL to grade"
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:border-[var(--color-brand)]"
          disabled={props.pending}
        />
        <button
          type="submit"
          disabled={disabled}
          aria-busy={props.pending}
          className="bg-[var(--color-brand)] text-[var(--color-on-brand)] px-4 py-2 font-semibold disabled:opacity-50"
        >
          {props.pending ? (<><Spinner className="mr-2" /> grading…</>) : 'grade'}
        </button>
      </div>
      <Turnstile onToken={onToken} />
      {waitingForCaptcha && (
        <div className="text-xs text-[var(--color-fg-muted)] flex items-center gap-2">
          <Spinner size={10} /> Verifying you're human…
        </div>
      )}
      {props.errorMessage !== undefined && (
        <div className="text-[var(--color-warn)] text-xs">{props.errorMessage}</div>
      )}
    </form>
  )
}
