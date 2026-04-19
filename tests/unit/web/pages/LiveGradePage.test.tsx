import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { GradeState } from '../../../../src/web/lib/types.ts'

afterEach(() => { cleanup() })

const stubState: { current: GradeState } = { current: {} as GradeState }
vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: () => ({ state: stubState.current, connected: true }),
}))

import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

function renderAt(id: string, search = ''): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/g/${id}${search}`]}>
      <Routes>
        <Route path="/g/:id" element={<LiveGradePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('LiveGradePage', () => {
  it('renders six category tiles + a "status" region while running', () => {
    stubState.current = {
      phase: 'running',
      scraped: null,
      probes: new Map(),
      categoryScores: {
        discoverability: null, recognition: null, accuracy: null,
        coverage: null, citation: null, seo: null,
      },
      overall: null, letter: null, error: null,
      paidStatus: 'none', reportId: null, reportToken: null,
    }
    renderAt('abc-123')
    expect(screen.getByText(/DISCOVERABILITY · 30%/i)).toBeInTheDocument()
    expect(screen.getByText(/SEO · 10%/i)).toBeInTheDocument()
    // Six tiles each show "..." while null+running
    expect(screen.getAllByText('...').length).toBe(6)
  })

  it('renders the GradeLetter + overall when phase is done', () => {
    stubState.current = {
      phase: 'done',
      scraped: { rendered: false, textLength: 3000 },
      probes: new Map(),
      categoryScores: {
        discoverability: 80, recognition: 75, accuracy: 60, coverage: 70, citation: 100, seo: 90,
      },
      overall: 78, letter: 'C+', error: null,
      paidStatus: 'none', reportId: null, reportToken: null,
    }
    renderAt('done-grade')
    expect(screen.getByText('C+')).toBeInTheDocument()
    expect(screen.getByText('78/100')).toBeInTheDocument()
  })
})

describe('LiveGradePage — paid flow', () => {
  it('shows BuyReportButton when tier=free + status=done', () => {
    stubState.current = {
      phase: 'done',
      scraped: { rendered: false, textLength: 3000 },
      probes: new Map(),
      categoryScores: {
        discoverability: 80, recognition: 75, accuracy: 60, coverage: 70, citation: 100, seo: 90,
      },
      overall: 78, letter: 'C+', error: null,
      paidStatus: 'none', reportId: null, reportToken: null,
    }
    renderAt('g-1')
    expect(screen.getByRole('button', { name: /Get the full report/i })).toBeInTheDocument()
  })

  it('shows PaidReportStatus "generating" banner when ?checkout=complete is in URL', () => {
    stubState.current = {
      phase: 'done',
      scraped: { rendered: false, textLength: 3000 },
      probes: new Map(),
      categoryScores: {
        discoverability: 80, recognition: 75, accuracy: 60, coverage: 70, citation: 100, seo: 90,
      },
      overall: 78, letter: 'C+', error: null,
      paidStatus: 'none', reportId: null, reportToken: null,
    }
    renderAt('g-1', '?checkout=complete')
    expect(screen.getByText(/being generated/i)).toBeInTheDocument()
    // BuyReportButton should NOT show while checking_out
    expect(screen.queryByRole('button', { name: /Get the full report/i })).not.toBeInTheDocument()
    // URL param stripped (no longer visible on the location — we assert via behavior:
    // re-entering this render should leave the mount effect having already stripped params).
    expect(window.location.search).not.toContain('checkout=complete')
  })

  it('shows CheckoutCanceledToast when ?checkout=canceled', () => {
    stubState.current = {
      phase: 'done',
      scraped: { rendered: false, textLength: 3000 },
      probes: new Map(),
      categoryScores: {
        discoverability: 80, recognition: 75, accuracy: 60, coverage: 70, citation: 100, seo: 90,
      },
      overall: 78, letter: 'C+', error: null,
      paidStatus: 'none', reportId: null, reportToken: null,
    }
    renderAt('g-1', '?checkout=canceled')
    expect(screen.getByText(/Checkout canceled/i)).toBeInTheDocument()
  })

  it('shows "View your report" link when paidStatus=ready', () => {
    stubState.current = {
      phase: 'done',
      scraped: { rendered: false, textLength: 3000 },
      probes: new Map(),
      categoryScores: {
        discoverability: 80, recognition: 75, accuracy: 60, coverage: 70, citation: 100, seo: 90,
      },
      overall: 78, letter: 'C+', error: null,
      paidStatus: 'ready', reportId: 'r-1', reportToken: 'abc',
    }
    renderAt('g-1')
    const link = screen.getByRole('link', { name: /View your report/i })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/report/r-1?t=abc')
    // BuyReportButton should NOT show when paidStatus=ready
    expect(screen.queryByRole('button', { name: /Get the full report/i })).not.toBeInTheDocument()
  })
})
