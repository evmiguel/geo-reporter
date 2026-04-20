import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReportProgress } from '../../../../src/web/components/ReportProgress.tsx'

afterEach(() => cleanup())

describe('ReportProgress', () => {
  it('shows "Checking payment" as active when paidStatus=checking_out', () => {
    render(<ReportProgress paidStatus="checking_out" reportProbeCount={0} />)
    expect(screen.getByText(/checking payment/i)).toBeInTheDocument()
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
  })

  it('shows probe counter detail during generating phase when count > 0', () => {
    render(<ReportProgress paidStatus="generating" reportProbeCount={3} />)
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
    expect(screen.getByText(/probe 3/i)).toBeInTheDocument()
  })

  it('does not show probe counter when count is 0', () => {
    render(<ReportProgress paidStatus="generating" reportProbeCount={0} />)
    expect(screen.queryByText(/probe 0/i)).toBeNull()
  })

  it('renders all four phase labels', () => {
    render(<ReportProgress paidStatus="generating" reportProbeCount={0} />)
    expect(screen.getByText(/checking payment/i)).toBeInTheDocument()
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
    expect(screen.getByText(/writing recommendations/i)).toBeInTheDocument()
    expect(screen.getByText(/rendering/i)).toBeInTheDocument()
  })

  it('renders nothing when paidStatus is none', () => {
    const { container } = render(<ReportProgress paidStatus="none" reportProbeCount={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when paidStatus is ready', () => {
    const { container } = render(<ReportProgress paidStatus="ready" reportProbeCount={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when paidStatus is failed', () => {
    const { container } = render(<ReportProgress paidStatus="failed" reportProbeCount={0} />)
    expect(container.firstChild).toBeNull()
  })
})
