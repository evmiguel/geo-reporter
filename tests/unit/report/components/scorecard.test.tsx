import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Scorecard } from '../../../../src/report/components/Scorecard.tsx'
import type { ScorecardCategory } from '../../../../src/report/types.ts'

describe('Scorecard', () => {
  const categories: ScorecardCategory[] = [
    { id: 'discoverability', label: 'Discoverability', weight: 30, score: 78, summary: 'Findable.' },
    { id: 'recognition', label: 'Recognition', weight: 20, score: 85, summary: 'Recognized.' },
    { id: 'accuracy', label: 'Accuracy', weight: 20, score: 62, summary: 'Mixed.' },
    { id: 'coverage', label: 'Coverage', weight: 10, score: 71, summary: 'Shallow.' },
    { id: 'citation', label: 'Citation', weight: 10, score: 80, summary: 'Cited.' },
    { id: 'seo', label: 'SEO', weight: 10, score: 93, summary: 'Passing.' },
  ]

  it('renders all 6 tiles', () => {
    const html = renderToStaticMarkup(<Scorecard categories={categories} />)
    expect(html).toContain('Discoverability')
    expect(html).toContain('30%')
    expect(html).toContain('78')
    expect(html).toContain('Passing.')
  })

  it('renders em dash when score is null', () => {
    const html = renderToStaticMarkup(
      <Scorecard categories={[{ id: 'seo', label: 'SEO', weight: 10, score: null, summary: 'Not measured.' }]} />,
    )
    expect(html).toContain('—')
  })
})
