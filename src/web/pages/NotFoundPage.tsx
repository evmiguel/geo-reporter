import React from 'react'
import { Link } from 'react-router-dom'

export function NotFoundPage(): JSX.Element {
  return (
    <div className="max-w-xl mx-auto px-4 py-24 text-center">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase mb-2">error</div>
      <h1 className="text-3xl text-[var(--color-warn)] mb-4">404</h1>
      <p className="text-[var(--color-fg-dim)] mb-8">route not found</p>
      <Link to="/" className="text-[var(--color-brand)]">← back to home</Link>
    </div>
  )
}
