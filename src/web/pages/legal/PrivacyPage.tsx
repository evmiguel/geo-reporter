import React from 'react'
import { LegalPage } from './LegalPage.tsx'
import { privacyHtml, privacyLastUpdated } from './copy/privacy-copy.ts'

export function PrivacyPage(): JSX.Element {
  return <LegalPage title="Privacy Policy" lastUpdated={privacyLastUpdated} html={privacyHtml} />
}
