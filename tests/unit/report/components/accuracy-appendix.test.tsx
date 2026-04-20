import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccuracyAppendix } from '../../../../src/report/components/AccuracyAppendix.tsx'
import type { AccuracyProbe } from '../../../../src/report/types.ts'

describe('AccuracyAppendix', () => {
  const probes: AccuracyProbe[] = [
    {
      question: 'What are stripe pricing tiers?',
      truth: 'Standard: 2.9% + 30¢.',
      rows: [
        { providerId: 'claude', providerLabel: 'Claude', answer: 'Standard 2.9% + 30¢.', ruling: 'correct', rationale: null },
        { providerId: 'gemini', providerLabel: 'Gemini', answer: 'Flat 3.5%.', ruling: 'wrong', rationale: 'fabricated' },
      ],
      summary: '1 of 2 correct.',
    },
  ]

  it('renders question, truth row, and each LLM row', () => {
    const html = renderToStaticMarkup(<AccuracyAppendix probes={probes} />)
    expect(html).toContain('What are stripe pricing tiers?')
    expect(html).toContain('Standard: 2.9% + 30¢.')
    expect(html).toContain('Claude')
    expect(html).toContain('Gemini')
    expect(html).toContain('1 of 2 correct')
  })

  it('renders empty state', () => {
    const html = renderToStaticMarkup(<AccuracyAppendix probes={[]} />)
    expect(html).toContain('not available')
  })
})
