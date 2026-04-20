import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postGrade, type CreateGradeResponse } from '../lib/api.ts'

export interface UseCreateGradeResult {
  create: (url: string) => Promise<void>
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

export function useCreateGrade(): UseCreateGradeResult {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function create(url: string): Promise<void> {
    setPending(true)
    setError(null)
    const result: CreateGradeResponse = await postGrade(url)
    setPending(false)
    if (result.ok) {
      navigate(`/g/${result.gradeId}`)
      return
    }
    if (result.kind === 'rate_limited') {
      if (result.paywall === 'daily_cap') {
        // Credit holders hitting 10/24h aren't a paywall problem — just a wait.
        // Keep them on the page with a clear message instead of bouncing them
        // to the email-verify gate (which would show wrong copy).
        setError(`Daily cap reached (${result.limit}/24h). Try again in ${formatRetry(result.retryAfter)}.`)
        return
      }
      navigate(`/email?retry=${result.retryAfter}`)
      return
    }
    if (result.kind === 'validation') {
      setError(result.message)
      return
    }
    setError(`Request failed (${result.status})`)
  }

  return { create, pending, error }
}
