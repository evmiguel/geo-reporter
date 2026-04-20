import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.ts'
import { DeleteAccountForm } from '../components/DeleteAccountForm.tsx'
import { BuyCreditsCTA } from '../components/BuyCreditsCTA.tsx'
import { GradeHistoryList } from '../components/GradeHistoryList.tsx'

export function AccountPage(): JSX.Element {
  const { verified, email, credits, loading, logout } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    // Wait for the first /auth/me to settle before deciding — otherwise we
    // bounce freshly-loaded verified users to /email because useAuth starts
    // at verified=false.
    if (!loading && !verified) navigate('/email?next=/account', { replace: true })
  }, [loading, verified, navigate])

  if (loading) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-sm text-[var(--color-fg-muted)]">
        Loading…
      </div>
    )
  }
  if (!verified || !email) return <div />

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <h1 className="text-2xl mb-6">Account</h1>

      <section className="mb-8">
        <div className="text-xs uppercase tracking-wider text-[var(--color-fg-muted)]">email</div>
        <div className="text-lg">{email}</div>
      </section>

      <section className="mb-8">
        <div className="text-xs uppercase tracking-wider text-[var(--color-fg-muted)]">credits</div>
        {credits > 0 ? (
          <div className="text-lg">{credits} remaining</div>
        ) : (
          <>
            <div className="text-lg text-[var(--color-fg-muted)]">None</div>
            <BuyCreditsCTA />
          </>
        )}
      </section>

      <section className="mb-8">
        <button onClick={() => void logout()} className="text-sm underline">Sign out</button>
      </section>

      <section className="mb-8">
        <h2 className="text-lg text-[var(--color-fg)] mb-3 pb-2 border-b border-[var(--color-line)]">Your grades</h2>
        <GradeHistoryList />
      </section>

      <section className="border-t border-[var(--color-line)] pt-8">
        <h2 className="text-lg text-[var(--color-warn)]">Delete account</h2>
        <DeleteAccountForm email={email} />
      </section>
    </div>
  )
}
