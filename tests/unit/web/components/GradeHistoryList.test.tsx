import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as api from '../../../../src/web/lib/api.ts'
import { GradeHistoryList } from '../../../../src/web/components/GradeHistoryList.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('GradeHistoryList', () => {
  it('renders each grade as a row with domain, overall/letter, tier, and view link', async () => {
    vi.spyOn(api, 'listMyGrades').mockResolvedValue([
      { id: 'g1', url: 'https://stripe.com/pricing', domain: 'stripe.com', tier: 'paid', status: 'done', overall: 87, letter: 'B', createdAt: '2026-04-20T12:00:00Z' },
      { id: 'g2', url: 'https://example.com', domain: 'example.com', tier: 'free', status: 'done', overall: 62, letter: 'D', createdAt: '2026-04-19T09:00:00Z' },
    ])
    render(<MemoryRouter><GradeHistoryList /></MemoryRouter>)
    expect(await screen.findByText('stripe.com')).toBeInTheDocument()
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText(/87/)).toBeInTheDocument()
    expect(screen.getByText(/62/)).toBeInTheDocument()
    const viewLinks = screen.getAllByRole('link', { name: /view/i })
    expect(viewLinks[0]).toHaveAttribute('href', '/g/g1')
    expect(viewLinks[1]).toHaveAttribute('href', '/g/g2')
  })

  it('renders empty state with a grade-a-site CTA when list is empty', async () => {
    vi.spyOn(api, 'listMyGrades').mockResolvedValue([])
    render(<MemoryRouter><GradeHistoryList /></MemoryRouter>)
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /grade a site/i })).toBeInTheDocument()
  })
})
