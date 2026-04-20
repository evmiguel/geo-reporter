import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listMyGrades, type GradeHistoryEntry } from '../lib/api.ts'

export function GradeHistoryList(): JSX.Element {
  const [grades, setGrades] = useState<GradeHistoryEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const g = await listMyGrades()
      if (!cancelled) setGrades(g)
    })()
    return () => { cancelled = true }
  }, [])

  if (grades === null) return <div className="text-xs text-[var(--color-fg-muted)]">Loading…</div>
  if (grades.length === 0) {
    return (
      <div className="text-xs text-[var(--color-fg-muted)]">
        No grades yet. Run one from the <Link to="/" className="text-[var(--color-brand)] underline">home page</Link>.
      </div>
    )
  }

  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {grades.map((g) => (
        <li key={g.id} className="py-2 flex items-center justify-between text-sm gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[var(--color-fg)] truncate">{g.domain}</div>
            <div className="text-xs text-[var(--color-fg-muted)] truncate">{g.url}</div>
          </div>
          <div className="flex items-center gap-3 text-xs shrink-0">
            {g.letter !== null && g.overall !== null && (
              <span className="font-mono text-[var(--color-fg)]">
                {g.letter} · {g.overall}
              </span>
            )}
            <span className="uppercase text-[10px] tracking-wider text-[var(--color-fg-muted)]">
              {g.tier}
            </span>
            <Link to={`/g/${g.id}`} className="text-[var(--color-brand)] underline">view</Link>
          </div>
        </li>
      ))}
    </ul>
  )
}
