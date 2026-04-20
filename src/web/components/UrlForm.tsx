import React, { useState, type FormEvent } from 'react'

export interface UrlFormProps {
  onSubmit: (url: string) => void
  pending: boolean
  errorMessage?: string
}

export function UrlForm(props: UrlFormProps): JSX.Element {
  const [value, setValue] = useState('')

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    props.onSubmit(trimmed)
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
          {props.pending ? 'grading…' : 'grade'}
        </button>
      </div>
      {props.errorMessage !== undefined && (
        <div className="text-[var(--color-warn)] text-xs">{props.errorMessage}</div>
      )}
    </form>
  )
}
