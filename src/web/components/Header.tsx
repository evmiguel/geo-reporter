import React from 'react'
import { Link } from 'react-router-dom'

export function Header(): JSX.Element {
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-bg-sidebar)] px-4 py-2 text-xs">
      <Link to="/" className="text-[var(--color-brand)]">geo-reporter</Link>
    </header>
  )
}
