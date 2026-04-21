import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postGrade, postGradeRedeem, type CreateGradeResponse } from '../lib/api.ts'
import type { GradeEvent } from '../lib/types.ts'
import { messageForFailKind, type FailKind } from '../lib/fail-messages.ts'
import { useAuth } from './useAuth.ts'

export type RateLimitedPaywall = 'daily_cap' | 'user_cap'

export interface UseCreateGradeResult {
  create: (url: string, turnstileToken?: string) => Promise<void>
  /** Spend 1 credit to run an additional grade beyond the 2/day free cap. */
  createWithCredit: (url: string, turnstileToken?: string) => Promise<void>
  pending: boolean
  error: string | null
  /**
   * When non-null, the last submit was blocked by a rate limit that a
   * credit can bypass. LandingPage uses this (combined with useAuth.credits)
   * to decide whether to show the "Grade (1 credit)" button.
   */
  rateLimited: RateLimitedPaywall | null
}

function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const leftoverMinutes = minutes % 60
  return leftoverMinutes > 0 ? `${hours}h ${leftoverMinutes}m` : `${hours}h`
}

const FAIL_PEEK_TIMEOUT_MS = 12_000

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
      if (event.type === 'running') return
      finish({ kind: 'continue' })
    }
    es.onerror = (): void => finish({ kind: 'continue' })
  })
}

export function useCreateGrade(): UseCreateGradeResult {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rateLimited, setRateLimited] = useState<RateLimitedPaywall | null>(null)
  const navigate = useNavigate()
  const { refresh: refreshAuth } = useAuth()

  async function create(url: string, turnstileToken?: string): Promise<void> {
    setPending(true)
    setError(null)
    setRateLimited(null)
    const result: CreateGradeResponse = await postGrade(url, turnstileToken)
    if (result.ok) {
      const peek = await peekForFailure(result.gradeId)
      setPending(false)
      if (peek.kind === 'failed') {
        setError(messageForFailKind(peek.failKind))
        return
      }
      navigate(`/g/${result.gradeId}`, { state: { fromSubmit: true } })
      return
    }
    setPending(false)
    if (result.kind === 'rate_limited') {
      if (result.paywall === 'daily_cap' || result.paywall === 'user_cap') {
        // Verified caller hit the 2/day free cap. LandingPage consumes this
        // signal + useAuth.credits to decide whether to offer the
        // "Grade (1 credit)" overflow. Message is a fallback for users with
        // zero credits.
        setRateLimited(result.paywall)
        setError(`Daily cap reached (${result.limit}/24h). Try again in ${formatRetry(result.retryAfter)}.`)
        return
      }
      if (result.paywall === 'ip_exhausted') {
        setError(
          `Too many grades from this network today. Sign in with email for more — or try again in ${formatRetry(result.retryAfter)}.`,
        )
        return
      }
      // paywall === 'email' — anon caller, route to sign-in gate.
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

  async function createWithCredit(url: string, turnstileToken?: string): Promise<void> {
    setPending(true)
    setError(null)
    setRateLimited(null)
    const result = await postGradeRedeem(url, turnstileToken)
    if (result.ok) {
      // A credit was spent server-side; pull the updated balance so the
      // header / account / BuyCreditsCTA reflect the new count before the
      // user navigates away. Fire-and-forget — if it's slow, the grade
      // page already navigates.
      void refreshAuth()
      const peek = await peekForFailure(result.gradeId)
      setPending(false)
      if (peek.kind === 'failed') {
        setError(messageForFailKind(peek.failKind))
        return
      }
      navigate(`/g/${result.gradeId}`, { state: { fromSubmit: true } })
      return
    }
    setPending(false)
    if (result.kind === 'no_credits') {
      setError("You're out of credits. Buy more below.")
      return
    }
    if (result.kind === 'must_verify_email') {
      setError('Please sign in first.')
      return
    }
    if (result.kind === 'captcha_failed') {
      setError("Couldn't verify you're human — please try again.")
      return
    }
    if (result.kind === 'validation') {
      setError(result.message ?? 'Invalid URL')
      return
    }
    if (result.kind === 'unknown') {
      setError(`Request failed (${result.status})`)
      return
    }
    setError('Request failed')
  }

  return { create, createWithCredit, pending, error, rateLimited }
}
