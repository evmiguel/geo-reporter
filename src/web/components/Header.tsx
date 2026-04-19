import React from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.ts'

export function Header(): JSX.Element {
  const { verified, logout } = useAuth()
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-bg-sidebar)] px-4 py-2 text-xs flex items-center justify-between">
      <Link to="/" className="text-[var(--color-brand)]">geo-reporter</Link>
      {verified && (
        <button
          type="button"
          onClick={() => void logout()}
          className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          sign out
        </button>
      )}
    </header>
  )
}
