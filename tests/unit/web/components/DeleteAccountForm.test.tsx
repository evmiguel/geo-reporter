import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DeleteAccountForm } from '../../../../src/web/components/DeleteAccountForm.tsx'
import * as api from '../../../../src/web/lib/api.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('DeleteAccountForm', () => {
  it('button is disabled until typed email matches exactly', async () => {
    render(<MemoryRouter><DeleteAccountForm email="u@example.com" /></MemoryRouter>)
    const btn = screen.getByRole('button', { name: /delete permanently/i })
    expect(btn).toBeDisabled()

    const input = screen.getByPlaceholderText(/type u@example\.com/i)
    const user = userEvent.setup()
    await user.type(input, 'u@example.co')   // one char short
    expect(btn).toBeDisabled()

    await user.type(input, 'm')
    expect(btn).not.toBeDisabled()
  })

  it('submit calls postAuthDeleteAccount with the typed email', async () => {
    const spy = vi.spyOn(api, 'postAuthDeleteAccount').mockResolvedValue({ ok: true })
    render(<MemoryRouter><DeleteAccountForm email="u@example.com" /></MemoryRouter>)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/type u@example\.com/i), 'u@example.com')
    await user.click(screen.getByRole('button', { name: /delete permanently/i }))
    expect(spy).toHaveBeenCalledWith('u@example.com')
  })

  it('shows email_mismatch error from server', async () => {
    vi.spyOn(api, 'postAuthDeleteAccount').mockResolvedValue({ ok: false, kind: 'email_mismatch' })
    render(<MemoryRouter><DeleteAccountForm email="u@example.com" /></MemoryRouter>)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/type u@example\.com/i), 'u@example.com')
    await user.click(screen.getByRole('button', { name: /delete permanently/i }))
    expect(await screen.findByText(/doesn't match/i)).toBeInTheDocument()
  })
})
