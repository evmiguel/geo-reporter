import React from 'react'
import { LegalPage } from './LegalPage.tsx'
import { cookiesHtml, cookiesLastUpdated } from './copy/cookies-copy.ts'

export function CookiesPage(): JSX.Element {
  return <LegalPage title="Cookie Policy" lastUpdated={cookiesLastUpdated} html={cookiesHtml} />
}
