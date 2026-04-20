import React from 'react'
import type { ScorecardCategory } from '../types.ts'

interface ScorecardProps { categories: ScorecardCategory[] }

function barColor(score: number | null): string {
  if (score === null) return '#bbb'
  if (score >= 90) return '#2a8a4a'
  if (score >= 70) return '#ff7a1a'
  if (score >= 50) return '#d97700'
  return '#c23030'
}

function numberColor(score: number | null): string {
  if (score === null) return '#bbb'
  if (score >= 90) return '#2a8a4a'
  if (score >= 50 && score < 70) return '#d97700'
  if (score < 50) return '#c23030'
  return '#1a1a1a'
}

export function Scorecard({ categories }: ScorecardProps): JSX.Element {
  return (
    <section id="scorecard">
      <h2>Scorecard</h2>
      <div className="scorecard">
        {categories.map((c) => (
          <div className="tile" key={c.id}>
            <div className="tile-header">
              <div className="uppercase-label">{c.label}</div>
              <div className="uppercase-label">{c.weight}%</div>
            </div>
            <div className="tile-number mono" style={{ color: numberColor(c.score) }}>
              {c.score ?? '—'}{c.score !== null ? <span className="unit">/100</span> : null}
            </div>
            <div className="tile-bar"><div style={{ width: `${c.score ?? 0}%`, background: barColor(c.score) }} /></div>
            <div className="tile-summary">{c.summary}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
