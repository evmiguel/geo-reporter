import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PaidReportPreview } from '../../../../src/web/components/PaidReportPreview.tsx'

afterEach(() => cleanup())

describe('PaidReportPreview', () => {
  it('renders the graded domain + letter + overall in the mini cover', () => {
    render(
      <MemoryRouter>
        <PaidReportPreview domain="stripe.com" letter="B" overall={87} />
      </MemoryRouter>,
    )
    expect(screen.getByText('stripe.com')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText(/87/)).toBeInTheDocument()
  })

  it('renders at least two sample recommendation cards', () => {
    render(
      <MemoryRouter>
        <PaidReportPreview domain="x.com" letter="C" overall={72} />
      </MemoryRouter>,
    )
    const recLabels = screen.getAllByText(/recommendation/i)
    expect(recLabels.length).toBeGreaterThanOrEqual(2)
  })

  it('renders the unlock CTA copy', () => {
    render(
      <MemoryRouter>
        <PaidReportPreview domain="x.com" letter="C" overall={72} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/unlock the full report/i)).toBeInTheDocument()
  })

  it('labels the card as a preview so users know it is a sample', () => {
    render(
      <MemoryRouter>
        <PaidReportPreview domain="x.com" letter="C" overall={72} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/preview/i)).toBeInTheDocument()
  })
})
