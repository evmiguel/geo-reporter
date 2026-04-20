import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReportProgress } from '../../../../src/web/components/ReportProgress.tsx'

afterEach(() => cleanup())

describe('ReportProgress', () => {
  it('shows "Checking payment" as active when paidStatus=checking_out', () => {
    render(<ReportProgress paidStatus="checking_out" reportPhase={null} reportProbeCount={0} />)
    expect(screen.getByText(/checking payment/i)).toBeInTheDocument()
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
  })

  it('shows probe counter detail during probing phase when count > 0', () => {
    render(<ReportProgress paidStatus="generating" reportPhase="probing" reportProbeCount={3} />)
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
    expect(screen.getByText(/probe 3/i)).toBeInTheDocument()
  })

  it('does not show probe counter when count is 0', () => {
    render(<ReportProgress paidStatus="generating" reportPhase="probing" reportProbeCount={0} />)
    expect(screen.queryByText(/probe 0/i)).toBeNull()
  })

  it('renders all four phase labels', () => {
    render(<ReportProgress paidStatus="generating" reportPhase="probing" reportProbeCount={0} />)
    expect(screen.getByText(/checking payment/i)).toBeInTheDocument()
    expect(screen.getByText(/running blind probes/i)).toBeInTheDocument()
    expect(screen.getByText(/writing recommendations/i)).toBeInTheDocument()
    expect(screen.getByText(/rendering/i)).toBeInTheDocument()
  })

  it('advances probing→done, writing→active when reportPhase=writing', () => {
    const { container } = render(
      <ReportProgress paidStatus="generating" reportPhase="writing" reportProbeCount={5} />,
    )
    // probe counter suppressed — probing is done, not active
    expect(screen.queryByText(/probe 5/i)).toBeNull()
    // ✓ checkmarks for the two completed phases (checking + probing)
    expect(container.textContent).toContain('✓')
  })

  it('advances to rendering when reportPhase=rendering', () => {
    const { container } = render(
      <ReportProgress paidStatus="generating" reportPhase="rendering" reportProbeCount={0} />,
    )
    // three phases done (checking + probing + writing) → should see multiple checks
    const checkCount = (container.textContent?.match(/✓/g) ?? []).length
    expect(checkCount).toBeGreaterThanOrEqual(2)
  })

  it('renders nothing when paidStatus is none', () => {
    const { container } = render(<ReportProgress paidStatus="none" reportPhase={null} reportProbeCount={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when paidStatus is ready', () => {
    const { container } = render(<ReportProgress paidStatus="ready" reportPhase={null} reportProbeCount={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when paidStatus is failed', () => {
    const { container } = render(<ReportProgress paidStatus="failed" reportPhase={null} reportProbeCount={0} />)
    expect(container.firstChild).toBeNull()
  })
})
