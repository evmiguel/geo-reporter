import React, { useReducer } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { initialGradeState, reduceGradeEvents } from '../../../../src/web/lib/grade-reducer.ts'
import type { GradeAction, GradeState } from '../../../../src/web/lib/types.ts'

afterEach(() => { cleanup() })

// Use the real reducer inside the mocked hook so dispatched hydrate_paid
// actions actually update state — that's the behavior we're verifying.
vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: (): { state: GradeState; connected: boolean; dispatch: (a: GradeAction) => void } => {
    const [state, dispatch] = useReducer(
      (s: GradeState, a: GradeAction) => reduceGradeEvents(s, a, 0),
      undefined,
      initialGradeState,
    )
    return { state, connected: true, dispatch }
  },
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => ({
    verified: false,
    email: null,
    credits: 0,
    refresh: async () => {},
    logout: async () => {},
  }),
}))

vi.mock('../../../../src/web/hooks/usePaidReportStatus.ts', () => ({
  usePaidReportStatus: () => ({ pdf: 'ready', loading: false }),
}))

vi.mock('../../../../src/web/lib/api.ts', () => ({
  getGrade: vi.fn(async () => ({
    id: 'g-hyd',
    url: 'https://stripe.com',
    domain: 'stripe.com',
    tier: 'paid',
    status: 'done',
    overall: 87,
    letter: 'B+',
    scores: {
      discoverability: 90, recognition: 80, accuracy: 85,
      coverage: 90, citation: 90, seo: 85,
    },
    createdAt: 't',
    updatedAt: 't',
    reportId: 'r-1',
    reportToken: 'tok-1',
  })),
}))

import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

describe('LiveGradePage — paid hydration on refresh', () => {
  it('dispatches hydrate_paid from GET /grades/:id so View report + Download PDF render', async () => {
    render(
      <MemoryRouter initialEntries={['/g/g-hyd']}>
        <Routes>
          <Route path="/g/:id" element={<LiveGradePage />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /View report/i })
      expect(link).toHaveAttribute('href', '/report/r-1?t=tok-1')
    })

    const pdfLink = screen.getByRole('link', { name: /Download PDF/i })
    expect(pdfLink).toHaveAttribute('href', '/report/r-1.pdf?t=tok-1')
  })
})
