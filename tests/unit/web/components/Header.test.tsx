import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

afterEach(() => cleanup())

// Because useAuth is imported inside Header.tsx at module load, we mock it
// BEFORE importing Header. `vi.hoisted` lets us share the mock object across
// the mock factory and per-test overrides.
const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    current: { verified: false, email: null as string | null, credits: 0, refresh: async () => {}, logout: vi.fn() },
  },
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => mockAuth.current,
}))

import { Header } from '../../../../src/web/components/Header.tsx'

describe('Header', () => {
  it('shows sign-out button when verified', () => {
    mockAuth.current = { verified: true, email: 'u@e.com', credits: 0, refresh: async () => {}, logout: vi.fn() }
    render(<MemoryRouter><Header /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })

  it('hides sign-out button when not verified', () => {
    mockAuth.current = { verified: false, email: null, credits: 0, refresh: async () => {}, logout: vi.fn() }
    render(<MemoryRouter><Header /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull()
  })

  it('calls logout when sign-out clicked', async () => {
    const logoutMock = vi.fn().mockResolvedValue(undefined)
    mockAuth.current = { verified: true, email: 'u@e.com', credits: 0, refresh: async () => {}, logout: logoutMock }
    const user = userEvent.setup()
    render(<MemoryRouter><Header /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: /sign out/i }))
    expect(logoutMock).toHaveBeenCalled()
  })
})
