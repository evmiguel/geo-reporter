import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Footer } from '../../../../src/web/components/Footer.tsx'

describe('Footer', () => {
  it('renders Privacy / Terms / Cookies links with correct hrefs', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>)
    const privacy = screen.getByRole('link', { name: /privacy/i })
    const terms = screen.getByRole('link', { name: /terms/i })
    const cookies = screen.getByRole('link', { name: /cookies/i })
    expect(privacy).toHaveAttribute('href', '/privacy')
    expect(terms).toHaveAttribute('href', '/terms')
    expect(cookies).toHaveAttribute('href', '/cookies')
  })
})
