import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

vi.mock('../../../../src/web/lib/api.ts', () => ({
  getGrade: vi.fn(async () => ({
    id: 'g1', url: 'https://x', domain: 'x',
    tier: 'paid', status: 'done', overall: 80, letter: 'B',
    scores: {}, createdAt: 't', updatedAt: 't',
  })),
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => ({ verified: true, email: 'u@x', credits: 2, refresh: async () => {}, logout: async () => {} }),
}))

vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: () => ({
    state: {
      phase: 'done' as const,
      scraped: null,
      probes: new Map(),
      categoryScores: { discoverability: 80, recognition: 80, accuracy: 80, coverage: 80, citation: 80, seo: 80 },
      overall: 80, letter: 'B', error: null, failedKind: null,
      paidStatus: 'generating' as const, reportId: null, reportToken: null, reportProbeCount: 0,
    reportPhase: null,
    },
    dispatch: vi.fn(),
    connected: true,
  }),
}))

describe('LiveGradePage during paid report generation', () => {
  it('does NOT render the BuyReportButton when paidStatus=generating', async () => {
    render(
      <MemoryRouter initialEntries={['/g/g1']}>
        <Routes><Route path="/g/:id" element={<LiveGradePage />} /></Routes>
      </MemoryRouter>,
    )
    // BuyReportButton's CTAs should be absent
    expect(screen.queryByRole('button', { name: /redeem 1 credit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get the full report/i })).not.toBeInTheDocument()
  })
})
