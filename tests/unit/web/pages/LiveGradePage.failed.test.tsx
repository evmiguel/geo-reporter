import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

vi.mock('../../../../src/web/lib/api.ts', () => ({
  getGrade: vi.fn(async () => ({
    id: 'g1', url: 'https://x.test', domain: 'x.test',
    tier: 'free', status: 'failed', overall: null, letter: null,
    scores: null, createdAt: 't', updatedAt: 't',
  })),
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => ({ verified: false, email: null, credits: 0, refresh: async () => {}, logout: async () => {} }),
}))

// Stateful stub — per-test we set the failedKind via a module-scoped let variable.
let currentFailedKind: 'provider_outage' | 'other' = 'other'
let currentError: string = ''
vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: () => ({
    state: {
      phase: 'failed' as const,
      scraped: null,
      probes: new Map(),
      categoryScores: { discoverability: null, recognition: null, accuracy: null, coverage: null, citation: null, seo: null },
      overall: null, letter: null, error: currentError, failedKind: currentFailedKind,
      paidStatus: 'none' as const, reportId: null, reportToken: null, reportProbeCount: 0,
    },
    dispatch: vi.fn(),
    connected: true,
  }),
}))

describe('LiveGradePage failed states', () => {
  it('renders provider-outage copy when failedKind=provider_outage', async () => {
    currentFailedKind = 'provider_outage'
    currentError = 'Anthropic 500 after retries'
    render(
      <MemoryRouter initialEntries={['/g/g1']}>
        <Routes><Route path="/g/:id" element={<LiveGradePage />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByText(/llm provider outage/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/didn't count against your daily limit/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /try another url/i })).toBeInTheDocument()
  })

  it('renders generic error copy when failedKind=other', async () => {
    currentFailedKind = 'other'
    currentError = 'scrape too small'
    render(
      <MemoryRouter initialEntries={['/g/g1']}>
        <Routes><Route path="/g/:id" element={<LiveGradePage />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByText(/scrape too small/i)).toBeInTheDocument()
    })
  })
})
