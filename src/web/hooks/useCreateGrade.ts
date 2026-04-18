import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postGrade, type CreateGradeResponse } from '../lib/api.ts'

export interface UseCreateGradeResult {
  create: (url: string) => Promise<void>
  pending: boolean
  error: string | null
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
