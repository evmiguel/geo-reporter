import { Routes, Route } from 'react-router-dom'
import { Header } from './components/Header.tsx'
import { LandingPage } from './pages/LandingPage.tsx'
import { LiveGradePage } from './pages/LiveGradePage.tsx'

export function App(): JSX.Element {
  return (
    <div className="min-h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-fg)]">
      <Header />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/g/:id" element={<LiveGradePage />} />
          <Route path="*" element={<div className="p-8 text-[var(--color-fg-dim)]">404 — route not implemented yet</div>} />
        </Routes>
      </main>
    </div>
  )
}
