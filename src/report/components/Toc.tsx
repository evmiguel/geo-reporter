import React from 'react'

const SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'cover', label: 'Cover' },
  { id: 'scorecard', label: 'Scorecard' },
  { id: 'raw-responses', label: 'Raw LLM responses' },
  { id: 'accuracy', label: 'Accuracy appendix' },
  { id: 'seo', label: 'SEO findings' },
  { id: 'recommendations', label: 'Recommendations' },
  { id: 'methodology', label: 'Methodology' },
]

export function Toc(): JSX.Element {
  return (
    <nav className="toc" aria-label="Table of contents">
      <div className="uppercase-label">Contents</div>
      <ol>
        {SECTIONS.map((s) => (
          <li key={s.id}><a href={`#${s.id}`}>{s.label}</a></li>
        ))}
      </ol>
    </nav>
  )
}
