import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postGrade, type CreateGradeResponse } from '../lib/api.ts'
import type { GradeEvent } from '../lib/types.ts'

export interface UseCreateGradeResult {
  create: (url: string, turnstileToken?: string) => Promise<void>
  pending: boolean
  error: string | null
}

function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const leftoverMinutes = minutes % 60
  return leftoverMinutes > 0 ? `${hours}h ${leftoverMinutes}m` : `${hours}h`
}

// Short SSE peek after submit: if the scrape fails fast (Reddit/X/etc.,
// which resolve in well under a second on the happy "block" path), catch
// it here and keep the user on the landing page with an inline error —
// avoids flashing through /g/<uuid> just to show a failure. On any other
// first event (or a 5s timeout) we navigate normally.
const SCRAPE_PEEK_TIMEOUT_MS = 5000

type ScrapePeekResult = { kind: 'scrape_failed'; message: string } | { kind: 'continue' }

async function peekForScrapeFailure(gradeId: string): Promise<ScrapePeekResult> {
  return new Promise((resolve) => {
    const es = new EventSource(`/grades/${gradeId}/events`, { withCredentials: true })
    const finish = (result: ScrapePeekResult): void => {
      clearTimeout(timer)
      es.close()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ kind: 'continue' }), SCRAPE_PEEK_TIMEOUT_MS)
    es.onmessage = (ev: MessageEvent<string>): void => {
      let event: GradeEvent
      try { event = JSON.parse(ev.data) as GradeEvent } catch { return }
      if (event.type === 'failed' && event.kind === 'scrape_failed') {
        finish({ kind: 'scrape_failed', message: event.error })
        return
      }
      // Any other first event — scraped, probe.started, done — means the grade
      // is real. Let LiveGradePage take over.
      finish({ kind: 'continue' })
    }
    es.onerror = (): void => finish({ kind: 'continue' })
  })
}

export function useCreateGrade(): UseCreateGradeResult {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function create(url: string, turnstileToken?: string): Promise<void> {
    setPending(true)
    setError(null)
    const result: CreateGradeResponse = await postGrade(url, turnstileToken)
    if (result.ok) {
      const peek = await peekForScrapeFailure(result.gradeId)
      setPending(false)
      if (peek.kind === 'scrape_failed') {
        setError(
          "We couldn't read that page. Some sites block automated tools — " +
          'marketing pages, blogs, and personal sites work best. This didn\'t ' +
          'count against your daily limit.',
        )
        return
      }
      navigate(`/g/${result.gradeId}`)
      return
    }
    setPending(false)
    if (result.kind === 'rate_limited') {
      if (result.paywall === 'daily_cap') {
        // Credit holders hitting 10/24h aren't a paywall problem — just a wait.
        // Keep them on the page with a clear message instead of bouncing them
        // to the email-verify gate (which would show wrong copy).
        setError(`Daily cap reached (${result.limit}/24h). Try again in ${formatRetry(result.retryAfter)}.`)
        return
      }
      if (result.paywall === 'ip_exhausted') {
        // Per-IP anonymous ceiling. Likely incognito abuse or shared-IP
        // overlap. Sign-in (identity) lifts this limit, so route to the
        // email gate with a distinct retry hint.
        setError(
          `Too many grades from this network today. Sign in with email for more — or try again in ${formatRetry(result.retryAfter)}.`,
        )
        return
      }
      navigate(`/email?retry=${result.retryAfter}`)
      return
    }
    if (result.kind === 'validation') {
      setError(result.message)
      return
    }
    if (result.kind === 'captcha_failed') {
      setError("Couldn't verify you're human — please try again.")
      return
    }
    setError(`Request failed (${result.status})`)
  }

  return { create, pending, error }
}
