import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const useAuthMock = vi.fn(() => ({
  verified: false, email: null as string | null, credits: 0,
  refresh: async () => {}, logout: async () => {},
}))
vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => useAuthMock(),
}))

import { AccountPage } from '../../../../src/web/pages/AccountPage.tsx'

describe('AccountPage', () => {
  it('renders email + credits when verified', () => {
    useAuthMock.mockReturnValue({
      verified: true, email: 'u@example.com', credits: 7,
      refresh: async () => {}, logout: async () => {},
    })
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Routes><Route path="/account" element={<AccountPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('u@example.com')).toBeInTheDocument()
    expect(screen.getByText(/7 remaining/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /delete account/i })).toBeInTheDocument()
  })

  it('shows "buy 10 for $29" link when credits === 0', () => {
    useAuthMock.mockReturnValue({
      verified: true, email: 'u@example.com', credits: 0,
      refresh: async () => {}, logout: async () => {},
    })
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Routes><Route path="/account" element={<AccountPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /buy 10 for \$29/i })).toBeInTheDocument()
  })

  it('redirects to /email?next=/account when not verified', () => {
    useAuthMock.mockReturnValue({
      verified: false, email: null, credits: 0,
      refresh: async () => {}, logout: async () => {},
    })
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
          <Route path="/email" element={<div>email gate</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText(/email gate/i)).toBeInTheDocument()
  })
})
