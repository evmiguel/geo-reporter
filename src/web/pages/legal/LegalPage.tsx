import React from 'react'
import { Link } from 'react-router-dom'

interface Props {
  title: string
  lastUpdated: string
  html: string
}

export function LegalPage({ title, lastUpdated, html }: Props): JSX.Element {
  return (
    <div className="max-w-3xl mx-auto px-4 py-16">
      <Link to="/" className="text-[var(--color-brand)] text-xs">← back to home</Link>
      <h1 className="text-3xl mt-4 mb-1">{title}</h1>
      <div className="text-sm text-[var(--color-fg-muted)] mb-8">Last updated {lastUpdated}</div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
