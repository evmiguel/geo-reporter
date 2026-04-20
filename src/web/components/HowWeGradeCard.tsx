import React from 'react'
import { CATEGORY_DESCRIPTIONS, ACCURACY_TIE_IN, ACCURACY_WHY_UNSCORED } from '../../scoring/descriptions.ts'

export function HowWeGradeCard(): JSX.Element {
  return (
    <section className="border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-4 mb-8">
      <h2 className="text-sm tracking-wider text-[var(--color-fg-muted)] uppercase mb-3">
        How we grade
      </h2>

      <dl className="space-y-3">
        {CATEGORY_DESCRIPTIONS.map((c) => (
          <div key={c.id}>
            <dt className="text-sm text-[var(--color-fg)]">
              <span className="font-semibold">{c.label}</span>
              <span className="text-[var(--color-fg-muted)]"> · {c.weight}%</span>
            </dt>
            <dd className="text-xs text-[var(--color-fg-dim)] mt-1 leading-relaxed">
              {c.short}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-5 pt-4 border-t border-[var(--color-line)]">
        <div className="text-xs text-[var(--color-fg-dim)] leading-relaxed">
          <span className="text-[var(--color-fg)] font-semibold">Discoverability vs. Accuracy.</span>{' '}
          {ACCURACY_TIE_IN}
        </div>
        <div className="text-xs text-[var(--color-fg-muted)] mt-3 leading-relaxed">
          <span className="italic">Why accuracy may be "unscored":</span> {ACCURACY_WHY_UNSCORED}
        </div>
      </div>
    </section>
  )
}
