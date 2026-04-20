import React from 'react'

interface CoverProps {
  domain: string
  letter: string | null
  overall: number | null
  generatedAt: Date
  pdfUrl: string
}

function fmtDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export function Cover({ domain, letter, overall, generatedAt, pdfUrl }: CoverProps): JSX.Element {
  return (
    <section id="cover" className="cover">
      <div className="cover-header">GEO Report</div>
      <h1 className="cover-domain">{domain}</h1>
      <div className="cover-score">
        <div className="cover-letter mono">{letter ?? '—'}</div>
        <div>
          <div className="cover-overall">{overall ?? '—'}<span className="muted"> / 100</span></div>
          <div className="uppercase-label">overall</div>
        </div>
      </div>
      <div className="cover-meta">graded {fmtDate(generatedAt)}</div>
      {pdfUrl ? (
        <div className="cover-actions">
          <a href={pdfUrl}>Download PDF</a>
        </div>
      ) : null}
    </section>
  )
}
