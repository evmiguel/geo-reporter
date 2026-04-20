import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth.ts'
import { Header } from './components/Header.tsx'
import { Footer } from './components/Footer.tsx'
import { LandingPage } from './pages/LandingPage.tsx'
import { LiveGradePage } from './pages/LiveGradePage.tsx'
import { EmailGatePage } from './pages/EmailGatePage.tsx'
import { AccountPage } from './pages/AccountPage.tsx'
import { NotFoundPage } from './pages/NotFoundPage.tsx'
import { PrivacyPage } from './pages/legal/PrivacyPage.tsx'
import { TermsPage } from './pages/legal/TermsPage.tsx'
import { CookiesPage } from './pages/legal/CookiesPage.tsx'

export function App(): JSX.Element {
  return (
    <AuthProvider>
      <div className="min-h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-fg)]">
        <Header />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/g/:id" element={<LiveGradePage />} />
            <Route path="/email" element={<EmailGatePage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/cookies" element={<CookiesPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </AuthProvider>
  )
}
