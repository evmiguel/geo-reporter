import React, { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { postAuthDeleteAccount } from '../lib/api.ts'

interface Props { email: string }

export function DeleteAccountForm({ email }: Props): JSX.Element {
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const matches = typed.trim().toLowerCase() === email.toLowerCase()

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (!matches) return
    setPending(true); setError(null)
    const result = await postAuthDeleteAccount(typed.trim())
    setPending(false)
    if (result.ok) { navigate('/?deleted=1'); return }
    if (result.kind === 'email_mismatch') { setError("Email doesn't match your account."); return }
    if (result.kind === 'not_authenticated') { setError('You were signed out. Please sign in again.'); return }
    setError('Something went wrong. Try again?')
  }

  return (
    <>
      <p className="text-sm text-[var(--color-fg-dim)] my-4">
        This erases every grade, report, and your email binding. Payment receipts are kept for
        tax/accounting but detached from your identity. This cannot be undone.
      </p>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="email"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Type ${email}`}
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-brand)]"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={!matches || pending}
          className="bg-[var(--color-warn)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
        >
          {pending ? '...' : 'Delete permanently'}
        </button>
      </form>
      {error !== null && <div className="text-xs text-[var(--color-brand)] mt-2">{error}</div>}
    </>
  )
}
