import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CreditBadge } from '../../../../src/web/components/CreditBadge.tsx'

afterEach(() => cleanup())

describe('CreditBadge', () => {
  it('renders plural count', () => {
    render(<CreditBadge credits={7} />)
    expect(screen.getByText('7 credits')).toBeInTheDocument()
  })

  it('renders singular count', () => {
    render(<CreditBadge credits={1} />)
    expect(screen.getByText('1 credit')).toBeInTheDocument()
  })
})
