import React from 'react'
import { LegalPage } from './LegalPage.tsx'
import { termsHtml, termsLastUpdated } from './copy/terms-copy.ts'

export function TermsPage(): JSX.Element {
  return <LegalPage title="Terms of Use" lastUpdated={termsLastUpdated} html={termsHtml} />
}
