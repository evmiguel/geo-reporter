import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.ts'
import { CreditBadge } from './CreditBadge.tsx'

export function Header(): JSX.Element {
  const { verified, credits, logout } = useAuth()
  const location = useLocation()
  // Only attach ?next= when the current path is worth returning to. Root (/)
  // and /email both land at /?verified=1 by default, so omit next there —
  // the server's path regex rejects bare "/" anyway.
  const signInHref = (location.pathname === '/' || location.pathname === '/email')
    ? '/email'
    : `/email?next=${encodeURIComponent(location.pathname + location.search)}`

  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-bg-sidebar)] px-6 py-4 text-xs flex items-center justify-between">
      <Link
        to="/"
        className="font-mono text-sm tracking-tight text-[var(--color-fg)] no-underline"
      >
        GEO reporter
      </Link>
      <div className="flex items-center gap-3">
        {verified && credits > 0 && <CreditBadge credits={credits} />}
        {verified ? (
          <>
            <Link
              to="/account"
              className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              account
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              sign out
            </button>
          </>
        ) : (
          <Link
            to={signInHref}
            className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            sign in
          </Link>
        )}
      </div>
    </header>
  )
}
