import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../../src/web/hooks/useCreateGrade.ts', () => ({
  useCreateGrade: () => ({ create: vi.fn(), pending: false, error: null }),
}))

import { LandingPage } from '../../../../src/web/pages/LandingPage.tsx'

afterEach(() => { cleanup() })

describe('LandingPage', () => {
  it('renders the landing title and URL form', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <LandingPage />
      </MemoryRouter>,
    )
    expect(screen.getByText(/How well do LLMs know your site\?/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'grade' })).toBeInTheDocument()
  })
})

describe('LandingPage — auth feedback', () => {
  it('renders toast when ?verified=1 is present', async () => {
    render(
      <MemoryRouter initialEntries={['/?verified=1']}>
        <LandingPage />
      </MemoryRouter>,
    )
    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent(/you're in/i)
  })

  it('renders auth_error banner when ?auth_error is present', () => {
    render(
      <MemoryRouter initialEntries={['/?auth_error=expired_or_invalid']}>
        <LandingPage />
      </MemoryRouter>,
    )
    expect(screen.getByText(/sign-in link didn't work/i)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /request a new link/i })
    expect(link).toHaveAttribute('href', '/email')
  })

  it('does not show toast or banner on plain /', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <LandingPage />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/sign-in link didn't work/i)).toBeNull()
  })
})
