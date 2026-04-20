import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.ts'
import { DeleteAccountForm } from '../components/DeleteAccountForm.tsx'
import { BuyCreditsCTA } from '../components/BuyCreditsCTA.tsx'
import { GradeHistoryList } from '../components/GradeHistoryList.tsx'

export function AccountPage(): JSX.Element {
  const { verified, email, credits, logout } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!verified) navigate('/email?next=/account', { replace: true })
  }, [verified, navigate])

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
        <div className="text-xs uppercase tracking-wider text-[var(--color-fg-muted)] mb-2">your grades</div>
        <GradeHistoryList />
      </section>

      <section className="border-t border-[var(--color-line)] pt-8">
        <h2 className="text-lg text-[var(--color-warn)]">Delete account</h2>
        <DeleteAccountForm email={email} />
      </section>
    </div>
  )
}
