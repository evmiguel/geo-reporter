import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { GradeState } from '../../../../src/web/lib/types.ts'

const stubState: { current: GradeState } = { current: {} as GradeState }
vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: () => ({ state: stubState.current, connected: true }),
}))

import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

function renderAt(id: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/g/${id}`]}>
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
