import React from 'react'
import type { ProbeGroup } from '../types.ts'

interface RawResponsesProps { groups: ProbeGroup[] }

export function RawResponses({ groups }: RawResponsesProps): JSX.Element {
  return (
    <section id="raw-responses">
      <h2>Raw LLM responses</h2>
      {groups.length === 0 ? (
        <p className="muted">Raw responses not available in this run.</p>
      ) : (
        groups.map((g, i) => (
          <details key={i} className="probe-group" open>
            <summary className="probe-header">
              <div className="uppercase-label">{g.category} probe</div>
              <div><strong>"{g.question}"</strong></div>
            </summary>
            <div className="probe-answers">
              {g.answers.map((a, j) => (
                <div className="probe-answer" key={j}>
                  <div className="probe-answer-head">
                    <div><strong>{a.providerLabel}</strong> <span className="muted small mono">{a.modelId}</span></div>
                    <div className="small mono muted">{a.score === null ? '—' : `score ${a.score}`}</div>
                  </div>
                  <div className="probe-answer-body">{a.response}</div>
                </div>
              ))}
            </div>
          </details>
        ))
      )}
    </section>
  )
}
