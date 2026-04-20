import React from 'react'

interface Props {
  domain: string
  letter: string
  overall: number
}

interface SampleRec {
  category: string
  title: string
  rationale: string
  impact: 'high' | 'medium' | 'low'
  effort: 'low' | 'medium' | 'high'
}

const SAMPLE_RECS: SampleRec[] = [
  {
    category: 'accuracy',
    title: 'Publish canonical product data',
    rationale: 'Several LLMs stated facts that didn\u2019t match your live site. Canonical JSON-LD metadata reduces drift.',
    impact: 'high',
    effort: 'medium',
  },
  {
    category: 'discoverability',
    title: 'Add an llms.txt at your root',
    rationale: 'Most providers now parse llms.txt when building their indexes. Without one, you rely on generic crawling.',
    impact: 'medium',
    effort: 'low',
  },
]

function impactBar(level: 'high' | 'medium' | 'low'): string {
  return level === 'high' ? 'w-full' : level === 'medium' ? 'w-2/3' : 'w-1/3'
}
function effortBar(level: 'low' | 'medium' | 'high'): string {
  return level === 'low' ? 'w-1/4' : level === 'medium' ? 'w-1/2' : 'w-3/4'
}

export function PaidReportPreview({ domain, letter, overall }: Props): JSX.Element {
  return (
    <section className="mt-6 border border-[var(--color-line)] bg-[var(--color-bg-accent)] p-4">
      <div className="text-[10px] tracking-wider uppercase text-[var(--color-fg-muted)] mb-3">
        Preview · full report
      </div>

      {/* Mini cover */}
      <div className="flex items-baseline justify-between border-b border-[var(--color-line)] pb-3 mb-4">
        <div className="text-lg text-[var(--color-fg)] font-mono">{domain}</div>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-mono text-[var(--color-brand)]">{letter}</div>
          <div className="text-sm font-mono text-[var(--color-fg-dim)]">{overall}/100</div>
        </div>
      </div>

      {/* Sample recs */}
      <div className="space-y-3 mb-4">
        {SAMPLE_RECS.map((rec, i) => (
          <div key={rec.title} className="border border-[var(--color-line)] p-3">
            <div className="text-[10px] tracking-wider uppercase text-[var(--color-fg-muted)]">
              Recommendation #{i + 1} · {rec.category}
            </div>
            <div className="text-sm text-[var(--color-fg)] font-semibold mt-1">{rec.title}</div>
            <div className="text-xs text-[var(--color-fg-dim)] mt-1">{rec.rationale}</div>
            <div className="mt-2 text-[10px] text-[var(--color-fg-muted)] space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-12">IMPACT</span>
                <span className="flex-1 h-1 bg-[var(--color-line)]">
                  <span className={`block h-full bg-[var(--color-brand)] ${impactBar(rec.impact)}`} />
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-12">EFFORT</span>
                <span className="flex-1 h-1 bg-[var(--color-line)]">
                  <span className={`block h-full bg-[var(--color-fg-dim)] ${effortBar(rec.effort)}`} />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Lock teaser — points at the real BuyReportButton below, not itself a CTA. */}
      <div className="text-center py-3 border-t border-[var(--color-line)]">
        <div className="text-xs text-[var(--color-fg-muted)]">🔒</div>
        <div className="text-[10px] text-[var(--color-fg-muted)] mt-1">
          4 LLM providers · 5–8 tailored recommendations · HTML + PDF
        </div>
        <div className="text-xs text-[var(--color-fg-dim)] mt-2">
          ↓ Unlock the full report below
        </div>
      </div>
    </section>
  )
}
