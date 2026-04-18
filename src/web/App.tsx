import { Routes, Route } from 'react-router-dom'
import { Header } from './components/Header.tsx'
import { LandingPage } from './pages/LandingPage.tsx'
import { LiveGradePage } from './pages/LiveGradePage.tsx'
import { EmailGatePage } from './pages/EmailGatePage.tsx'
import { NotFoundPage } from './pages/NotFoundPage.tsx'

export function App(): JSX.Element {
  return (
    <div className="min-h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-fg)]">
      <Header />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/g/:id" element={<LiveGradePage />} />
          <Route path="/email" element={<EmailGatePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  )
}
