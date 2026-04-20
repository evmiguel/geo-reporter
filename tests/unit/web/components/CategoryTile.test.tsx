import React from 'react'
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CategoryTile } from '../../../../src/web/components/CategoryTile.tsx'

describe('CategoryTile', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders "..." when score is null and phase is running', () => {
    render(<CategoryTile category="seo" weight={10} score={null} phase="running" />)
    expect(screen.getByText(/SEO · 10%/i)).toBeInTheDocument()
    expect(screen.getByText('...')).toBeInTheDocument()
  })

  it('renders the score as a number when provided', () => {
    render(<CategoryTile category="discoverability" weight={30} score={85} phase="done" />)
    expect(screen.getByText('85')).toBeInTheDocument()
  })

  it('shows "—" + unscored label when score is null and phase is done (accuracy skipped)', () => {
    render(<CategoryTile category="accuracy" weight={20} score={null} phase="done" />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText(/unscored/i)).toBeInTheDocument()
  })

  it('uses good (green) class for score ≥ 80', () => {
    const { container } = render(<CategoryTile category="seo" weight={10} score={90} phase="done" />)
    expect(container.querySelector('[data-score]')?.className).toContain('color-good')
  })

  it('uses brand (orange) class for score in 70-79 (C tier)', () => {
    const { container } = render(<CategoryTile category="seo" weight={10} score={75} phase="done" />)
    expect(container.querySelector('[data-score]')?.className).toContain('color-brand')
  })

  it('uses warn class for score in 60-69 (D tier)', () => {
    const { container } = render(<CategoryTile category="seo" weight={10} score={65} phase="done" />)
    expect(container.querySelector('[data-score]')?.className).toContain('color-warn')
  })

  it('uses bad (red) class for score < 60 (F)', () => {
    const { container } = render(<CategoryTile category="seo" weight={10} score={40} phase="done" />)
    expect(container.querySelector('[data-score]')?.className).toContain('color-bad')
  })

  it('renders letter grade for numeric score', () => {
    render(<CategoryTile category="discoverability" weight={30} score={85} phase="done" />)
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText('85')).toBeInTheDocument()
  })

  it('omits letter when score is null (unscored)', () => {
    render(<CategoryTile category="accuracy" weight={20} score={null} phase="done" />)
    expect(screen.queryByText(/^[A-F]$/)).toBeNull()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('unscored')).toBeInTheDocument()
  })
})
