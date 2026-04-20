import React from 'react'
import type { RecommendationCard } from '../types.ts'

interface RecommendationsProps { cards: RecommendationCard[] }

export function Recommendations({ cards }: RecommendationsProps): JSX.Element {
  return (
    <section id="recommendations">
      <h2>Recommendations</h2>
      {cards.length === 0 ? (
        <p className="muted">Recommendations not available in this run.</p>
      ) : (
        cards.map((c, i) => (
          <div className="rec-card" key={i}>
            <div>
              <div className="rec-header">#{i + 1} · {c.category}</div>
              <h3 className="rec-title">{c.title}</h3>
              <p className="rec-prose">{c.rationale}</p>
              <div className="rec-how"><strong>How:</strong> {c.how}</div>
            </div>
            <div className="rec-rail">
              <div className="rec-priority mono">{c.priority}</div>
              <div className="rec-priority-label">priority</div>
              <div className="rec-bar-label">IMPACT</div>
              <div className="rec-bar"><div style={{ width: `${(c.impact / 5) * 100}%` }} /></div>
              <div className="rec-bar-label">EFFORT</div>
              <div className="rec-bar effort"><div style={{ width: `${(c.effort / 5) * 100}%` }} /></div>
            </div>
          </div>
        ))
      )}
    </section>
  )
}
