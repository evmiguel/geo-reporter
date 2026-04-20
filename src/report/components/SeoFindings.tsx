import React from 'react'
import type { SeoSignal } from '../types.ts'

interface SeoFindingsProps { signals: SeoSignal[] }

export function SeoFindings({ signals }: SeoFindingsProps): JSX.Element {
  if (signals.length === 0) {
    return <section id="seo"><h2>SEO findings</h2><p className="muted">SEO findings not available in this run.</p></section>
  }
  const pass = signals.filter((s) => s.pass).length
  const fail = signals.length - pass
  return (
    <section id="seo">
      <h2>SEO findings</h2>
      <div className="seo-list">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f0ece2' }}>
          <div className="small">{signals.length} signals checked</div>
          <div className="small mono"><span className="good">{pass} pass</span> · <span className={fail > 0 ? 'bad' : 'muted'}>{fail} fail</span></div>
        </div>
        {signals.map((s, i) => (
          <div className={`seo-row ${s.pass ? '' : 'fail'}`} key={i}>
            <div className={`seo-mark ${s.pass ? 'good' : 'bad'}`}>{s.pass ? '✓' : '✗'}</div>
            <div style={{ flex: 1 }}>
              <div className="seo-label">{s.label}</div>
              <div className="seo-detail">{s.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
