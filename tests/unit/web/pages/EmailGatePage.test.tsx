import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { EmailGatePage } from '../../../../src/web/pages/EmailGatePage.tsx'
import * as api from '../../../../src/web/lib/api.ts'

afterEach(() => cleanup())
beforeEach(() => { vi.restoreAllMocks() })

describe('EmailGatePage', () => {
  it('shows resend cooldown after successful submit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(api, 'postAuthMagic').mockResolvedValue({ ok: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<MemoryRouter><EmailGatePage /></MemoryRouter>)
    await user.type(screen.getByPlaceholderText(/you@example.com/i), 'me@example.com')
    await user.click(screen.getByRole('button', { name: /send link/i }))

    // After success, resend button visible and disabled with countdown
    const resend = await screen.findByRole('button', { name: /resend in \d+s/i })
    expect(resend).toBeDisabled()

    // Advance 60s — button should become enabled as "Resend link"
    act(() => { vi.advanceTimersByTime(60_000) })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^resend link$/i })).not.toBeDisabled()
    })

    vi.useRealTimers()
  })

  it('shows rate_limit_email error with retryAfter seconds', async () => {
    vi.spyOn(api, 'postAuthMagic').mockResolvedValue({
      ok: false,
      error: 'rate_limit_email',
      retryAfter: 42,
    })
    const user = userEvent.setup()
    render(<MemoryRouter><EmailGatePage /></MemoryRouter>)
    await user.type(screen.getByPlaceholderText(/you@example.com/i), 'me@example.com')
    await user.click(screen.getByRole('button', { name: /send link/i }))
    expect(await screen.findByText(/wait 42s/i)).toBeInTheDocument()
  })
})
