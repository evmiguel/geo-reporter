import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuyCreditsCTA } from '../../../../src/web/components/BuyCreditsCTA.tsx'
import * as api from '../../../../src/web/lib/api.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('BuyCreditsCTA', () => {
  it('clicking redirects to the Stripe URL on success', async () => {
    vi.spyOn(api, 'postBillingBuyCredits').mockResolvedValue({ ok: true, url: 'https://stripe.test/credits' })
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock, href: '' })
    const user = userEvent.setup()
    render(<BuyCreditsCTA />)
    await user.click(screen.getByRole('button', { name: /get credits/i }))
    expect(assignMock).toHaveBeenCalledWith('https://stripe.test/credits')
  })

  it('shows must_verify_email error', async () => {
    vi.spyOn(api, 'postBillingBuyCredits').mockResolvedValue({ ok: false, kind: 'must_verify_email' })
    const user = userEvent.setup()
    render(<BuyCreditsCTA />)
    await user.click(screen.getByRole('button', { name: /get credits/i }))
    expect(await screen.findByText(/verify your email/i)).toBeInTheDocument()
  })

  it('shows unavailable error', async () => {
    vi.spyOn(api, 'postBillingBuyCredits').mockResolvedValue({ ok: false, kind: 'unavailable' })
    const user = userEvent.setup()
    render(<BuyCreditsCTA />)
    await user.click(screen.getByRole('button', { name: /get credits/i }))
    expect(await screen.findByText(/unavailable right now/i)).toBeInTheDocument()
  })
})
