import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RawResponses } from '../../../../src/report/components/RawResponses.tsx'
import type { ProbeGroup } from '../../../../src/report/types.ts'

describe('RawResponses', () => {
  const groups: ProbeGroup[] = [
    {
      category: 'discoverability', question: 'What is stripe.com?',
      answers: [
        { providerId: 'claude', providerLabel: 'Claude', modelId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', response: 'Payments.', score: 80 },
        { providerId: 'gpt', providerLabel: 'GPT', modelId: 'gpt-4.1-mini', modelLabel: 'GPT-4.1 mini', response: 'A company.', score: 60 },
      ],
    },
  ]

  it('renders question and all provider answers', () => {
    const html = renderToStaticMarkup(<RawResponses groups={groups} />)
    expect(html).toContain('What is stripe.com?')
    expect(html).toContain('Claude')
    expect(html).toContain('GPT')
    expect(html).toContain('Payments.')
    expect(html).toContain('<details')
  })

  it('renders empty-state prose when no groups', () => {
    const html = renderToStaticMarkup(<RawResponses groups={[]} />)
    expect(html).toContain('not available')
  })
})
