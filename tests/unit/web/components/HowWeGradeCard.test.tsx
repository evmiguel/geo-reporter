import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { HowWeGradeCard } from '../../../../src/web/components/HowWeGradeCard.tsx'

afterEach(() => cleanup())

describe('HowWeGradeCard', () => {
  it('renders all six category labels', () => {
    render(<HowWeGradeCard />)
    expect(screen.getByText('Discoverability')).toBeInTheDocument()
    expect(screen.getByText('Recognition')).toBeInTheDocument()
    expect(screen.getByText('Accuracy')).toBeInTheDocument()
    expect(screen.getByText('Coverage')).toBeInTheDocument()
    expect(screen.getByText('Citation')).toBeInTheDocument()
    expect(screen.getByText('SEO')).toBeInTheDocument()
  })

  it('renders weight percentages (Discoverability 30%, two at 20%, three at 10%)', () => {
    render(<HowWeGradeCard />)
    expect(screen.getByText(/· 30%/)).toBeInTheDocument()
    expect(screen.getAllByText(/· 20%/)).toHaveLength(2)
    expect(screen.getAllByText(/· 10%/)).toHaveLength(3)
  })

  it('ties accuracy to discoverability', () => {
    render(<HowWeGradeCard />)
    expect(screen.getByText(/discoverability vs\. accuracy/i)).toBeInTheDocument()
    expect(screen.getByText(/do llms know you exist/i)).toBeInTheDocument()
  })

  it('explains why accuracy may be unscored', () => {
    render(<HowWeGradeCard />)
    expect(screen.getByText(/why accuracy may be "unscored"/i)).toBeInTheDocument()
    expect(screen.getByText(/500 characters/i)).toBeInTheDocument()
  })
})
