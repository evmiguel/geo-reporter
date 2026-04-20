import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Cover } from '../../../../src/report/components/Cover.tsx'

describe('Cover component', () => {
  it('renders domain, letter grade, overall score', () => {
    const html = renderToStaticMarkup(
      <Cover
        domain="stripe.com"
        letter="B+"
        overall={87}
        generatedAt={new Date('2026-04-19T14:32:00Z')}
        pdfUrl="/report/abc.pdf?t=tok"
      />,
    )
    expect(html).toContain('stripe.com')
    expect(html).toContain('B+')
    expect(html).toContain('87')
    expect(html).toContain('Download PDF')
  })

  it('shows "not graded" when letter is null', () => {
    const html = renderToStaticMarkup(
      <Cover domain="x.test" letter={null} overall={null} generatedAt={new Date()} pdfUrl={null} />,
    )
    expect(html).toContain('—')
  })

  it('omits the Download PDF link when pdfUrl is null (PDF render path)', () => {
    const html = renderToStaticMarkup(
      <Cover
        domain="stripe.com"
        letter="B+"
        overall={87}
        generatedAt={new Date('2026-04-19T14:32:00Z')}
        pdfUrl={null}
      />,
    )
    expect(html).not.toContain('Download PDF')
    expect(html).not.toContain('cover-actions')
  })
})
