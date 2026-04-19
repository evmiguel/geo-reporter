import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PaidReportStatus } from '../../../../src/web/components/PaidReportStatus.tsx'

afterEach(() => cleanup())

describe('PaidReportStatus', () => {
  it('generating state shows banner + time hint', () => {
    render(<PaidReportStatus status="generating" reportId={null} reportToken={null} error={null} />)
    expect(screen.getByText(/being generated/i)).toBeInTheDocument()
    expect(screen.getByText(/30-60 seconds/i)).toBeInTheDocument()
  })

  it('ready state shows link with token', () => {
    render(<PaidReportStatus status="ready" reportId="r-1" reportToken="abc" error={null} />)
    const link = screen.getByRole('link', { name: /view your report/i })
    expect(link).toHaveAttribute('href', '/report/r-1?t=abc')
  })

  it('failed state shows error banner', () => {
    render(<PaidReportStatus status="failed" reportId={null} reportToken={null} error="boom" />)
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    expect(screen.getByText(/boom/i)).toBeInTheDocument()
  })
})
