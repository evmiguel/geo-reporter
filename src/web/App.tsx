import { Routes, Route } from 'react-router-dom'

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<div className="p-8"><h1 className="text-[var(--color-brand)] text-xl">geo-reporter</h1><p className="text-[var(--color-fg-dim)] mt-2">frontend scaffold — pages coming in subsequent tasks</p></div>} />
    </Routes>
  )
}
