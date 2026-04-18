import React from 'react'
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ProbeLogRow } from '../../../../src/web/components/ProbeLogRow.tsx'
import type { ProbeEntry } from '../../../../src/web/lib/types.ts'

function makeProbe(overrides: Partial<ProbeEntry> = {}): ProbeEntry {
  return {
    key: 'seo:-:title',
    category: 'seo',
    provider: null,
    label: 'title',
    status: 'completed',
    score: 100,
    durationMs: 123,
    error: null,
    startedAt: 1000,
    ...overrides,
  }
}

describe('ProbeLogRow', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows a ✓ glyph for completed probes', () => {
    render(<ProbeLogRow probe={makeProbe({ status: 'completed' })} />)
    expect(screen.getByText(/✓/)).toBeInTheDocument()
  })

  it('shows a ▶ glyph for started probes', () => {
    render(<ProbeLogRow probe={makeProbe({ status: 'started', score: null })} />)
    expect(screen.getByText(/▶/)).toBeInTheDocument()
  })

  it('renders category/provider/label (with - for null provider)', () => {
    render(<ProbeLogRow probe={makeProbe({ provider: null, label: 'title' })} />)
    expect(screen.getByText(/seo\/-\/title/)).toBeInTheDocument()
  })

  it('renders the error message when present', () => {
    render(<ProbeLogRow probe={makeProbe({ status: 'completed', score: null, error: 'rate limited' })} />)
    expect(screen.getByText(/rate limited/)).toBeInTheDocument()
  })
})
