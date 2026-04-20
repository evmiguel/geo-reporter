import React from 'react'
import type { AccuracyProbe, AccuracyRow } from '../types.ts'

interface AccuracyAppendixProps { probes: AccuracyProbe[] }

function rulingSymbol(r: AccuracyRow['ruling']): { char: string; cls: string } {
  if (r === 'correct') return { char: '✓', cls: 'good' }
  if (r === 'partial') return { char: '⚠', cls: 'warn' }
  if (r === 'wrong') return { char: '✗', cls: 'bad' }
  return { char: '·', cls: 'muted' }
}

export function AccuracyAppendix({ probes }: AccuracyAppendixProps): JSX.Element {
  return (
    <section id="accuracy">
      <h2>Accuracy appendix</h2>
      {probes.length === 0 ? (
        <p className="muted">Accuracy appendix not available in this run.</p>
      ) : (
        probes.map((p, i) => (
          <div className="accuracy-card" key={i}>
            <div className="uppercase-label">Probe {i + 1} of {probes.length}</div>
            <h3>"{p.question}"</h3>
            <table className="accuracy-table">
              <thead>
                <tr><th>Source</th><th>Answer</th><th style={{ textAlign: 'right', width: 80 }}>Ruling</th></tr>
              </thead>
              <tbody>
                {p.truth ? (
                  <tr className="truth">
                    <td><strong className="good">Site</strong></td>
                    <td>{p.truth}</td>
                    <td style={{ textAlign: 'right' }}><span className="good mono small">TRUTH</span></td>
                  </tr>
                ) : null}
                {p.rows.map((r, j) => {
                  const sym = rulingSymbol(r.ruling)
                  return (
                    <tr key={j}>
                      <td><strong>{r.providerLabel}</strong></td>
                      <td>{r.answer}</td>
                      <td style={{ textAlign: 'right' }}><span className={`${sym.cls} mono small`}>{sym.char}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="accuracy-summary"><span className="uppercase-label">Verifier ruling</span><br />{p.summary}</div>
          </div>
        ))
      )}
    </section>
  )
}
