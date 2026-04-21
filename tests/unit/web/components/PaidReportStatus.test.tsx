import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PaidReportStatus } from '../../../../src/web/components/PaidReportStatus.tsx'

vi.mock('../../../../src/web/hooks/usePaidReportStatus.ts', () => ({
  usePaidReportStatus: vi.fn(() => ({ pdf: 'pending', loading: false })),
}))

afterEach(() => cleanup())

describe('PaidReportStatus', () => {
  it('ready state shows link with token', () => {
    render(<PaidReportStatus status="ready" reportId="r-1" reportToken="abc" error={null} refundKind={null} />)
    const link = screen.getByRole('link', { name: /view report/i })
    expect(link).toHaveAttribute('href', '/report/r-1?t=abc')
  })

  it('failed state shows error banner', () => {
    render(<PaidReportStatus status="failed" reportId={null} reportToken={null} error="boom" refundKind={null} />)
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    expect(screen.getByText(/boom/i)).toBeInTheDocument()
  })

  it('renders credit-refund copy when status=refunded + refundKind=credit', () => {
    render(<PaidReportStatus status="refunded" reportId={null} reportToken={null} error={null} refundKind="credit" />)
    expect(screen.getByText(/refunded/i)).toBeInTheDocument()
    expect(screen.getByText(/credit is back/i)).toBeInTheDocument()
  })

  it('renders stripe-refund copy when status=refunded + refundKind=stripe', () => {
    render(<PaidReportStatus status="refunded" reportId={null} reportToken={null} error={null} refundKind="stripe" />)
    expect(screen.getByText(/\$19 payment has been refunded/i)).toBeInTheDocument()
  })
})

describe('PaidReportStatus PDF surface', () => {
  it('renders "View report" + "PDF generating…" when pdf=pending', () => {
    render(<PaidReportStatus status="ready" reportId="id1" reportToken="tok1" error={null} refundKind={null} />)
    expect(screen.getByText('View report →')).toBeDefined()
    expect(screen.getByText(/PDF generating/i)).toBeDefined()
  })

  it('renders enabled PDF link when pdf=ready', async () => {
    const { usePaidReportStatus } = await import('../../../../src/web/hooks/usePaidReportStatus.ts')
    ;(usePaidReportStatus as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({ pdf: 'ready', loading: false })
    render(<PaidReportStatus status="ready" reportId="id2" reportToken="tok2" error={null} refundKind={null} />)
    const pdfLink = screen.getByRole('link', { name: /download pdf/i })
    expect(pdfLink).toHaveAttribute('href', '/report/id2.pdf?t=tok2')
  })

  it('renders "PDF unavailable" when pdf=failed', async () => {
    const { usePaidReportStatus } = await import('../../../../src/web/hooks/usePaidReportStatus.ts')
    ;(usePaidReportStatus as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({ pdf: 'failed', loading: false })
    render(<PaidReportStatus status="ready" reportId="id3" reportToken="tok3" error={null} refundKind={null} />)
    expect(screen.getByText(/PDF unavailable/i)).toBeDefined()
  })
})
