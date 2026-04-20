import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

vi.mock('../../../../src/web/lib/api.ts', () => ({
  getGrade: vi.fn(async () => ({
    id: 'g1', url: 'https://stripe.com/pricing', domain: 'stripe.com',
    tier: 'free', status: 'done', overall: 80, letter: 'B',
    scores: {}, createdAt: 't', updatedAt: 't',
  })),
}))

vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: () => ({
    state: {
      phase: 'running', probes: new Map(), categoryScores: {},
      overall: null, letter: null, error: null, paidStatus: 'none',
      reportId: null, reportToken: null, scraped: null, reportProbeCount: 0,
    reportPhase: null,
    },
    dispatch: vi.fn(),
    connected: true,
  }),
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => ({ verified: false, email: null, credits: 0, refresh: async () => {}, logout: async () => {} }),
}))

describe('LiveGradePage URL header', () => {
  it('shows the domain as title and the full URL as subtitle after hydration', async () => {
    render(
      <MemoryRouter initialEntries={['/g/g1']}>
        <Routes><Route path="/g/:id" element={<LiveGradePage />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'stripe.com' })).toBeInTheDocument()
      expect(screen.getByText('https://stripe.com/pricing')).toBeInTheDocument()
    })
  })
})
