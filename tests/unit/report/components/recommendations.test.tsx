import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Recommendations } from '../../../../src/report/components/Recommendations.tsx'
import type { RecommendationCard } from '../../../../src/report/types.ts'

describe('Recommendations', () => {
  const cards: RecommendationCard[] = [
    { rank: 1, category: 'accuracy', title: 'Publish pricing', impact: 5, effort: 2, priority: 20, rationale: 'LLMs invent.', how: 'Add JSON-LD.' },
    { rank: 2, category: 'discoverability', title: 'Add llms.txt', impact: 4, effort: 1, priority: 20, rationale: 'Missing.', how: 'Create file.' },
  ]

  it('renders title, category, priority and impact/effort', () => {
    const html = renderToStaticMarkup(<Recommendations cards={cards} />)
    expect(html).toContain('Publish pricing')
    expect(html).toContain('accuracy')
    expect(html).toContain('20')
    expect(html).toContain('Add JSON-LD.')
  })

  it('renders empty state', () => {
    const html = renderToStaticMarkup(<Recommendations cards={[]} />)
    expect(html).toContain('not available')
  })
})
