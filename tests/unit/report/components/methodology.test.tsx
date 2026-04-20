import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Methodology } from '../../../../src/report/components/Methodology.tsx'

describe('Methodology', () => {
  it('lists models and report metadata', () => {
    const html = renderToStaticMarkup(
      <Methodology
        models={[
          { providerId: 'claude', modelId: 'claude-sonnet-4-6' },
          { providerId: 'gemini', modelId: 'gemini-2.5-flash' },
        ]}
        reportId="abc"
        gradeId="def"
        generatedAt={new Date('2026-04-19T14:32:00Z')}
      />,
    )
    expect(html).toContain('Claude Sonnet 4.6')
    expect(html).toContain('Gemini 2.5 Flash')
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).toContain('abc')
    expect(html).toContain('def')
  })
})
