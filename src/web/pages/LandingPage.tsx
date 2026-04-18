import { useCreateGrade } from '../hooks/useCreateGrade.ts'
import { UrlForm } from '../components/UrlForm.tsx'

export function LandingPage(): JSX.Element {
  const { create, pending, error } = useCreateGrade()

  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">landing</div>
      <h1 className="text-3xl mt-2 mb-2 text-[var(--color-fg)]">How well do LLMs know your site?</h1>
      <p className="text-[var(--color-fg-dim)] mb-8">
        We scrape your page, ask four LLMs about you, and score the results across six categories.
      </p>
      <UrlForm
        onSubmit={(url) => { void create(url) }}
        pending={pending}
        {...(error !== null ? { errorMessage: error } : {})}
      />
    </div>
  )
}
