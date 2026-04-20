import React from 'react'
import { Link } from 'react-router-dom'

export function Footer(): JSX.Element {
  return (
    <footer className="max-w-2xl mx-auto px-4 py-8 mt-16 text-xs text-[var(--color-fg-muted)] flex gap-4 justify-end">
      <Link to="/privacy">Privacy</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/cookies">Cookies</Link>
    </footer>
  )
}
