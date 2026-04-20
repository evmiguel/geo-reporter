import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { PrivacyPage } from '../../../../../src/web/pages/legal/PrivacyPage.tsx'
import { TermsPage } from '../../../../../src/web/pages/legal/TermsPage.tsx'
import { CookiesPage } from '../../../../../src/web/pages/legal/CookiesPage.tsx'

describe('Legal pages', () => {
  it('PrivacyPage renders its copy under an h1 "Privacy Policy"', () => {
    render(
      <MemoryRouter><Routes><Route path="/" element={<PrivacyPage />} /></Routes></MemoryRouter>,
    )
    expect(screen.getByRole('heading', { level: 1, name: /privacy policy/i })).toBeInTheDocument()
    expect(screen.getByText(/last updated/i)).toBeInTheDocument()
  })

  it('TermsPage renders its copy under an h1 "Terms of Use"', () => {
    render(
      <MemoryRouter><Routes><Route path="/" element={<TermsPage />} /></Routes></MemoryRouter>,
    )
    expect(screen.getByRole('heading', { level: 1, name: /terms of use/i })).toBeInTheDocument()
  })

  it('CookiesPage renders its copy under an h1 "Cookie Policy"', () => {
    render(
      <MemoryRouter><Routes><Route path="/" element={<CookiesPage />} /></Routes></MemoryRouter>,
    )
    expect(screen.getByRole('heading', { level: 1, name: /cookie policy/i })).toBeInTheDocument()
  })
})
