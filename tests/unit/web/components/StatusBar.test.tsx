import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from '../../../../src/web/components/StatusBar.tsx'

describe('StatusBar', () => {
  it('highlights the running dot when phase is running', () => {
    const { container } = render(<StatusBar phase="running" scraped={null} />)
    const runningSpan = [...container.querySelectorAll('span')].find((s) => s.textContent?.includes('running'))
    expect(runningSpan?.className).toContain('color-brand')
  })

  it('shows scraped info when scraped payload is passed', () => {
    render(<StatusBar phase="scraped" scraped={{ rendered: true, textLength: 5432 }} />)
    expect(screen.getByText(/5432 chars/i)).toBeInTheDocument()
    expect(screen.getByText(/rendered/i)).toBeInTheDocument()
  })
})
