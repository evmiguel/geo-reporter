import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../../src/web/hooks/useCreateGrade.ts', () => ({
  useCreateGrade: () => ({ create: vi.fn(), pending: false, error: null }),
}))

interface AuthState {
  verified: boolean
  email: string | null
  credits: number
  refresh: () => Promise<void>
  logout: () => Promise<void>
}
const useAuthMock = vi.fn((): AuthState => ({
  verified: false,
  email: null,
  credits: 0,
  refresh: async () => {},
  logout: async () => {},
}))
vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => useAuthMock(),
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
    expect(toast).toHaveTextContent(/credits unlock more grades/i)
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

describe('LandingPage — BuyCreditsCTA visibility', () => {
  afterEach(() => {
    useAuthMock.mockReturnValue({
      verified: false, email: null, credits: 0,
      refresh: async () => {}, logout: async () => {},
    })
  })

  it('hides BuyCreditsCTA when not verified', () => {
    useAuthMock.mockReturnValue({
      verified: false, email: null, credits: 0,
      refresh: async () => {}, logout: async () => {},
    })
    render(<MemoryRouter initialEntries={['/']}><LandingPage /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: /get credits/i })).toBeNull()
  })

  it('shows BuyCreditsCTA when verified with 0 credits', () => {
    useAuthMock.mockReturnValue({
      verified: true, email: 'u@example.com', credits: 0,
      refresh: async () => {}, logout: async () => {},
    })
    render(<MemoryRouter initialEntries={['/']}><LandingPage /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /get credits/i })).toBeInTheDocument()
  })

  it('hides BuyCreditsCTA when verified with credits > 0', () => {
    useAuthMock.mockReturnValue({
      verified: true, email: 'u@example.com', credits: 5,
      refresh: async () => {}, logout: async () => {},
    })
    render(<MemoryRouter initialEntries={['/']}><LandingPage /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: /get credits/i })).toBeNull()
  })
})

describe('LandingPage — credits URL params', () => {
  it('renders purchased toast when ?credits=purchased', async () => {
    render(
      <MemoryRouter initialEntries={['/?credits=purchased']}>
        <LandingPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/10 credits added/i)).toBeInTheDocument()
  })

  it('renders canceled toast when ?credits=canceled', async () => {
    render(
      <MemoryRouter initialEntries={['/?credits=canceled']}>
        <LandingPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/checkout canceled/i)).toBeInTheDocument()
  })
})
