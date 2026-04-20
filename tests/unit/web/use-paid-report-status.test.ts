import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { usePaidReportStatus } from '../../../src/web/hooks/usePaidReportStatus.ts'

describe('usePaidReportStatus', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('returns "ready" immediately if server responds ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ html: 'ready', pdf: 'ready' }), { status: 200 })))
    const { result } = renderHook(() => usePaidReportStatus('id1', 'tok1'))
    await waitFor(() => expect(result.current.pdf).toBe('ready'))
  })

  it('polls until pdf is ready', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      const pdf = call < 3 ? 'pending' : 'ready'
      return new Response(JSON.stringify({ html: 'ready', pdf }), { status: 200 })
    }))
    const { result } = renderHook(() => usePaidReportStatus('id2', 'tok2'))
    await waitFor(() => expect(result.current.pdf).toBe('pending'))
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(result.current.pdf).toBe('ready'))
  })

  it('stops polling on "failed"', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ html: 'ready', pdf: 'failed' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() => usePaidReportStatus('id3', 'tok3'))
    await waitFor(() => expect(result.current.pdf).toBe('failed'))
    const callsAtFailure = fetchSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchSpy.mock.calls.length).toBe(callsAtFailure)
  })
})
