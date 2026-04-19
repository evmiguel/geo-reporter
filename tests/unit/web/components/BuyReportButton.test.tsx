import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuyReportButton } from '../../../../src/web/components/BuyReportButton.tsx'
import * as api from '../../../../src/web/lib/api.ts'

const authState = vi.hoisted(() => ({
  current: {
    verified: false as boolean,
    email: null as string | null,
    credits: 0,
    refresh: async () => {},
    logout: async () => {},
  },
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => authState.current,
}))

beforeEach(() => {
  authState.current = {
    verified: false,
    email: null,
    credits: 0,
    refresh: async () => {},
    logout: async () => {},
  }
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('BuyReportButton', () => {
  it('clicking redirects on success', async () => {
    vi.spyOn(api, 'postBillingCheckout').mockResolvedValue({ ok: true, url: 'https://stripe.test/cs_1' })
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock, href: '' })
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    await user.click(screen.getByRole('button', { name: /full report/i }))
    expect(assignMock).toHaveBeenCalledWith('https://stripe.test/cs_1')
  })

  it('calls onAlreadyPaid on 409 already_paid', async () => {
    vi.spyOn(api, 'postBillingCheckout').mockResolvedValue({ ok: false, kind: 'already_paid', reportId: 'r-1' })
    const onAlreadyPaid = vi.fn()
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={onAlreadyPaid} />)
    await user.click(screen.getByRole('button', { name: /full report/i }))
    expect(onAlreadyPaid).toHaveBeenCalledWith('r-1')
  })

  it('shows grade_not_done error', async () => {
    vi.spyOn(api, 'postBillingCheckout').mockResolvedValue({ ok: false, kind: 'grade_not_done' })
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    await user.click(screen.getByRole('button', { name: /full report/i }))
    expect(await screen.findByText(/not done yet/i)).toBeInTheDocument()
  })
})

describe('BuyReportButton — credits branch', () => {
  it('shows "Redeem 1 credit (N left)" label when credits > 0', () => {
    authState.current = {
      verified: true, email: 'u@ex.com', credits: 5,
      refresh: async () => {}, logout: async () => {},
    }
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    expect(screen.getByRole('button', { name: /redeem 1 credit \(4 left\)/i })).toBeInTheDocument()
  })

  it('shows "$19" label when credits === 0', () => {
    authState.current = {
      verified: true, email: 'u@ex.com', credits: 0,
      refresh: async () => {}, logout: async () => {},
    }
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    expect(screen.getByRole('button', { name: /full report — \$19/i })).toBeInTheDocument()
  })

  it('clicking redeem calls postBillingRedeemCredit; does not redirect', async () => {
    authState.current = {
      verified: true, email: 'u@ex.com', credits: 3,
      refresh: async () => {}, logout: async () => {},
    }
    const redeemSpy = vi.spyOn(api, 'postBillingRedeemCredit').mockResolvedValue({ ok: true })
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock, href: '' })
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    await user.click(screen.getByRole('button', { name: /redeem/i }))
    expect(redeemSpy).toHaveBeenCalledWith('g-1')
    expect(assignMock).not.toHaveBeenCalled()
  })

  it('shows no_credits error after failed redeem', async () => {
    authState.current = {
      verified: true, email: 'u@ex.com', credits: 1,
      refresh: async () => {}, logout: async () => {},
    }
    vi.spyOn(api, 'postBillingRedeemCredit').mockResolvedValue({ ok: false, kind: 'no_credits' })
    const user = userEvent.setup()
    render(<BuyReportButton gradeId="g-1" onAlreadyPaid={() => {}} />)
    await user.click(screen.getByRole('button', { name: /redeem/i }))
    expect(await screen.findByText(/no credits available/i)).toBeInTheDocument()
  })
})
