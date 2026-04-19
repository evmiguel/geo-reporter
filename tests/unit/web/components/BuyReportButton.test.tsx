import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuyReportButton } from '../../../../src/web/components/BuyReportButton.tsx'
import * as api from '../../../../src/web/lib/api.ts'

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
