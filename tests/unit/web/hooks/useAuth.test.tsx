import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { AuthProvider, useAuth } from '../../../../src/web/hooks/useAuth.ts'

beforeEach(() => { vi.restoreAllMocks() })

function wrapper({ children }: { children: React.ReactNode }): JSX.Element {
  return <AuthProvider>{children}</AuthProvider>
}

describe('useAuth', () => {
  it('starts unverified; refresh() pulls from /auth/me with credits', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true, email: 'u@ex.com', credits: 7 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.verified).toBe(true))
    expect(result.current.email).toBe('u@ex.com')
    expect(result.current.credits).toBe(7)
  })

  it('logout() posts to /auth/logout and refreshes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true, email: 'u@ex.com' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.verified).toBe(true))
    await act(async () => { await result.current.logout() })
    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(result.current.verified).toBe(false))
  })

  it('shares state across multiple consumers (single provider instance)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true, email: 'u@ex.com', credits: 3 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    // Two consumers under the same provider — logout from consumer A should
    // be observable by consumer B (the original bug was per-instance state).
    const { result } = renderHook(
      () => ({ a: useAuth(), b: useAuth() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.a.verified).toBe(true))
    expect(result.current.b.verified).toBe(true)
    await act(async () => { await result.current.a.logout() })
    expect(result.current.b.verified).toBe(false)
  })
})
