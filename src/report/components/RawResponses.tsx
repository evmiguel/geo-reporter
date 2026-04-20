import React from 'react'
import type { CategoryId, ProbeGroup } from '../types.ts'
import { Markdown } from './Markdown.tsx'

interface RawResponsesProps { groups: ProbeGroup[] }

const CATEGORY_LABEL: Record<CategoryId, string> = {
  discoverability: 'Discoverability',
  recognition: 'Recognition',
  accuracy: 'Accuracy',
  coverage: 'Coverage',
  citation: 'Citation',
  seo: 'SEO',
}

// Self-gen probes (just discoverability today) give each provider a unique
// question, so a "group" ends up with 1 answer. In that case, include the
// provider in the header so repeated "Discoverability probe" rows are
// distinguishable. For shared-question probes (recognition/coverage/citation),
// the same question is compared across all providers and the plain label is fine.
function headerLabel(g: ProbeGroup): string {
  const category = CATEGORY_LABEL[g.category]
  if (g.answers.length === 1) {
    const only = g.answers[0]!
    return `${category} probe — ${only.providerLabel}`
  }
  return `${category} probe`
}

export function RawResponses({ groups }: RawResponsesProps): JSX.Element {
  return (
    <section id="raw-responses">
      <h2>Raw LLM responses</h2>
      {groups.length === 0 ? (
        <p className="muted">Raw responses not available in this run.</p>
      ) : (
        <>
          {groups.map((g, i) => (
            <details key={i} className="probe-group" open>
              <summary className="probe-header">
                <div className="uppercase-label">{headerLabel(g)}</div>
                <div><strong>"{g.question}"</strong></div>
              </summary>
              <div className="probe-answers">
                {g.answers.map((a, j) => (
                  <div className="probe-answer" key={j}>
                    <div className="probe-answer-head">
                      <div><strong>{a.providerLabel}</strong> <span className="muted small mono">{a.modelId}</span></div>
                      <div className="small mono muted">{a.score === null ? '—' : `score ${a.score}`}</div>
                    </div>
                    <Markdown className="probe-answer-body markdown">{a.response}</Markdown>
                  </div>
                ))}
              </div>
            </details>
          ))}
          <p className="small muted" style={{ marginTop: 12 }}>
            Accuracy probes (fact-checking) appear in the{' '}
            <a href="#accuracy" style={{ color: '#ff7a1a' }}>Accuracy appendix</a>{' '}
            below — they have their own format with a ground-truth row and a verifier ruling.
          </p>
        </>
      )}
    </section>
  )
}
