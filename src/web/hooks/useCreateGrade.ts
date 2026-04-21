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

// Short SSE peek after submit: a grade that fails before any visible
// progress should stay on the landing page, not flash the user through
// /g/<uuid>. We catch ANY failure kind in this window — scrape_failed
// (Reddit/X block us), provider_outage (Claude/GPT down), and 'other'
// (exceptions during category runs). Happy path — scraped / probe.started
// arriving first — means the grade is real; we navigate normally.
// Window is generous (12s) to cover fetchHtml's 10s timeout + a beat.
const FAIL_PEEK_TIMEOUT_MS = 12_000

type FailKind = 'scrape_failed' | 'provider_outage' | 'other'
type PeekResult = { kind: 'failed'; failKind: FailKind; message: string } | { kind: 'continue' }

async function peekForFailure(gradeId: string): Promise<PeekResult> {
  return new Promise((resolve) => {
    const es = new EventSource(`/grades/${gradeId}/events`, { withCredentials: true })
    const finish = (result: PeekResult): void => {
      clearTimeout(timer)
      es.close()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ kind: 'continue' }), FAIL_PEEK_TIMEOUT_MS)
    es.onmessage = (ev: MessageEvent<string>): void => {
      let event: GradeEvent
      try { event = JSON.parse(ev.data) as GradeEvent } catch { return }
      if (event.type === 'failed') {
        finish({ kind: 'failed', failKind: event.kind, message: event.error })
        return
      }
      // IMPORTANT: ignore `running`. The server synthesizes a `running`
      // event at connect time for ANY non-terminal grade (see
      // src/server/routes/grades-events.ts:40-42). If we treated it as
      // "grade is real" we'd navigate before the worker published the
      // real failure event — exactly the race that kept showing the
      // "grade failed" screen on Reddit/etc. Keep waiting.
      if (event.type === 'running') return
      // Any other event — scraped, probe.started, done, category.completed —
      // means actual progress. Grade is real; LiveGradePage can take over.
      finish({ kind: 'continue' })
    }
    es.onerror = (): void => finish({ kind: 'continue' })
  })
}

function messageForFailKind(failKind: FailKind): string {
  if (failKind === 'scrape_failed') {
    return "We couldn't read that page. Some sites block automated tools — " +
      "marketing pages, blogs, and personal sites work best. This didn't " +
      'count against your daily limit.'
  }
  if (failKind === 'provider_outage') {
    return "Claude or ChatGPT wasn't reachable. Give it a minute and try " +
      "again. This didn't count against your daily limit."
  }
  return "Something went wrong while grading that site. This didn't count " +
    'against your daily limit — try again, or pick a different URL.'
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
      const peek = await peekForFailure(result.gradeId)
      setPending(false)
      if (peek.kind === 'failed') {
        setError(messageForFailKind(peek.failKind))
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
