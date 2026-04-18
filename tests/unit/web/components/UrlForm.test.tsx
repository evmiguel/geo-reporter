import React from 'react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UrlForm } from '../../../../src/web/components/UrlForm.tsx'

describe('UrlForm', () => {
  afterEach(() => {
    cleanup()
  })

  it('calls onSubmit with the trimmed URL when the button is clicked', async () => {
    const onSubmit = vi.fn()
    render(<UrlForm onSubmit={onSubmit} pending={false} />)
    await userEvent.type(screen.getByRole('textbox'), '  https://acme.com  ')
    await userEvent.click(screen.getByRole('button', { name: 'grade' }))
    expect(onSubmit).toHaveBeenCalledWith('https://acme.com')
  })

  it('does not call onSubmit on empty input', async () => {
    const onSubmit = vi.fn()
    render(<UrlForm onSubmit={onSubmit} pending={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'grade' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renders error message when errorMessage prop is set', () => {
    render(<UrlForm onSubmit={() => undefined} pending={false} errorMessage="Invalid URL" />)
    expect(screen.getByText('Invalid URL')).toBeInTheDocument()
  })

  it('disables button when pending', () => {
    render(<UrlForm onSubmit={() => undefined} pending={true} />)
    expect(screen.getByRole('button', { name: 'grading…' })).toBeDisabled()
  })
})
