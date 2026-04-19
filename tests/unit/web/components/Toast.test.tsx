import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { Toast } from '../../../../src/web/components/Toast.tsx'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); cleanup() })

describe('Toast', () => {
  it('renders the message', () => {
    render(<Toast message="hi" onDismiss={() => {}} />)
    expect(screen.getByText('hi')).toBeInTheDocument()
  })

  it('auto-dismisses after durationMs (default 5000)', () => {
    const onDismiss = vi.fn()
    render(<Toast message="hi" onDismiss={onDismiss} />)
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('respects custom durationMs', () => {
    const onDismiss = vi.fn()
    render(<Toast message="hi" durationMs={2000} onDismiss={onDismiss} />)
    act(() => { vi.advanceTimersByTime(1999) })
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
