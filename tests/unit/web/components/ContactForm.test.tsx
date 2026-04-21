import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContactForm } from '../../../../src/web/components/ContactForm.tsx'
import * as api from '../../../../src/web/lib/api.ts'

afterEach(() => cleanup())
beforeEach(() => { vi.restoreAllMocks() })

describe('ContactForm', () => {
  it('submits email + category + body via postContactMessage', async () => {
    const spy = vi.spyOn(api, 'postContactMessage').mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<ContactForm />)

    await user.type(screen.getByLabelText(/your email/i), 'me@example.com')
    // Default category is 'bug'; no need to change it.
    await user.type(screen.getByLabelText(/message/i), 'Something broke on the grade page.')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(spy).toHaveBeenCalledWith(
      'me@example.com',
      'bug',
      'Something broke on the grade page.',
      undefined,
    )
  })

  it('shows a thank-you message after a successful submit', async () => {
    vi.spyOn(api, 'postContactMessage').mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<ContactForm />)
    await user.type(screen.getByLabelText(/your email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/message/i), 'Just a long enough message.')
    await user.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/thanks/i)).toBeInTheDocument()
  })

  it('surfaces rate_limited errors', async () => {
    vi.spyOn(api, 'postContactMessage').mockResolvedValue({
      ok: false, kind: 'rate_limited', retryAfter: 3600,
    })
    const user = userEvent.setup()
    render(<ContactForm />)
    await user.type(screen.getByLabelText(/your email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/message/i), 'Just a long enough message.')
    await user.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/max messages for today/i)).toBeInTheDocument()
  })

  it('surfaces captcha_failed errors', async () => {
    vi.spyOn(api, 'postContactMessage').mockResolvedValue({ ok: false, kind: 'captcha_failed' })
    const user = userEvent.setup()
    render(<ContactForm />)
    await user.type(screen.getByLabelText(/your email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/message/i), 'Just a long enough message.')
    await user.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/verify you're human/i)).toBeInTheDocument()
  })

  it('blocks submit with too-short body', async () => {
    const spy = vi.spyOn(api, 'postContactMessage').mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<ContactForm />)
    await user.type(screen.getByLabelText(/your email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/message/i), 'short')
    await user.click(screen.getByRole('button', { name: /send/i }))
    expect(spy).not.toHaveBeenCalled()
    expect(await screen.findByText(/fill in both fields/i)).toBeInTheDocument()
  })
})
