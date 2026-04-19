import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useAuth } from '../../../../src/web/hooks/useAuth.ts'

beforeEach(() => { vi.restoreAllMocks() })

describe('useAuth', () => {
  it('starts unverified; refresh() pulls from /auth/me with credits', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true, email: 'u@ex.com', credits: 7 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAuth())
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
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.verified).toBe(true))
    await act(async () => { await result.current.logout() })
    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(result.current.verified).toBe(false))
  })
})
