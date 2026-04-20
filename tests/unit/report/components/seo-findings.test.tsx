import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SeoFindings } from '../../../../src/report/components/SeoFindings.tsx'
import type { SeoSignal } from '../../../../src/report/types.ts'

describe('SeoFindings', () => {
  const signals: SeoSignal[] = [
    { label: 'robots.txt', pass: true, detail: '200 OK' },
    { label: 'llms.txt', pass: false, detail: 'Missing.' },
  ]

  it('renders pass/fail signals with count', () => {
    const html = renderToStaticMarkup(<SeoFindings signals={signals} />)
    expect(html).toContain('robots.txt')
    expect(html).toContain('llms.txt')
    expect(html).toContain('1 fail')
    expect(html).toContain('seo-row fail')
  })

  it('renders empty state', () => {
    const html = renderToStaticMarkup(<SeoFindings signals={[]} />)
    expect(html).toContain('not available')
  })
})
