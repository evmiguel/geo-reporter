import React from 'react'
import type { ModelSnapshot } from '../types.ts'
import { friendlyModelName } from '../model-names.ts'
import { CATEGORY_DESCRIPTIONS } from '../../scoring/descriptions.ts'

interface MethodologyProps {
  models: ModelSnapshot[]
  reportId: string
  gradeId: string
  generatedAt: Date
}

export function Methodology({ models, reportId, gradeId, generatedAt }: MethodologyProps): JSX.Element {
  return (
    <section id="methodology" className="method">
      <h2>Methodology</h2>

      <h3>How we score</h3>
      <dl>
        {CATEGORY_DESCRIPTIONS.map((c) => (
          <React.Fragment key={c.id}>
            <dt>{c.label} ({c.weight}%)</dt>
            <dd>{c.short}</dd>
          </React.Fragment>
        ))}
      </dl>

      <h3>How accuracy works</h3>
      <ul>
        <li>A generator LLM reads a scrape of your site and writes a specific, verifiable question.</li>
        <li>Each target LLM answers the question blind — no access to the scrape.</li>
        <li>A verifier LLM compares each answer against the scrape and rules correct / partial / wrong.</li>
      </ul>

      <h3>Which LLMs graded this report</h3>
      <ul>
        {models.map((m) => (
          <li key={`${m.providerId}:${m.modelId}`}>
            {friendlyModelName(m.modelId)} <span className="muted small mono">({m.modelId})</span>
          </li>
        ))}
      </ul>
      <p className="small muted" style={{ marginTop: 8 }}>
        Claude / GPT / Gemini transparently fall back to OpenRouter on provider errors. Perplexity calls its API directly.
      </p>

      <h3>Grade scale</h3>
      <ul>
        <li>A: 90+</li><li>B: 80–89</li><li>C: 70–79</li><li>D: 60–69</li><li>F: below 60</li>
      </ul>

      <h3>Caveats</h3>
      <ul>
        <li>LLM grades drift. A single run is a snapshot, not a verdict.</li>
        <li>Model weights update monthly — re-grade quarterly to track movement.</li>
        <li>A score is a direction. Use the recommendations to drive improvement.</li>
      </ul>

      <h3>Report metadata</h3>
      <p className="small mono muted">
        report {reportId}<br />
        grade {gradeId}<br />
        generated {generatedAt.toISOString()}
      </p>
      <p className="small muted" style={{ marginTop: 8 }}>
        <a href="https://geo.erikamiguel.com/privacy" className="small muted">View privacy policy</a>
      </p>
    </section>
  )
}
