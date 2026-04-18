import type { CategoryId } from './types.ts'

export interface GradeSummary {
  id: string
  url: string
  domain: string
  tier: 'free' | 'paid'
  status: 'queued' | 'running' | 'done' | 'failed'
  overall: number | null
  letter: string | null
  scores: Record<CategoryId, number | null> | null
  createdAt: string
  updatedAt: string
}

export interface CreateGradeOk { ok: true; gradeId: string }
export interface CreateGradeRateLimited {
  ok: false
  kind: 'rate_limited'
  paywall: 'email' | 'pay'
  limit: number
  used: number
  retryAfter: number
}
export interface CreateGradeValidationError { ok: false; kind: 'validation'; message: string }
export interface CreateGradeUnknownError { ok: false; kind: 'unknown'; status: number }

export type CreateGradeResponse = CreateGradeOk | CreateGradeRateLimited | CreateGradeValidationError | CreateGradeUnknownError

export async function postGrade(url: string): Promise<CreateGradeResponse> {
  let res: Response
  try {
    res = await fetch('/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ url }),
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }

  if (res.status === 202) {
    const body = (await res.json()) as { gradeId: string }
    return { ok: true, gradeId: body.gradeId }
  }
  if (res.status === 429) {
    const body = (await res.json()) as { paywall: 'email' | 'pay'; limit: number; used: number; retryAfter: number }
    return { ok: false, kind: 'rate_limited', ...body }
  }
  if (res.status === 400) {
    let message = 'Invalid URL'
    try {
      const body = (await res.json()) as { error?: { issues?: { message: string }[] } }
      const first = body.error?.issues?.[0]
      if (first) message = first.message
    } catch { /* keep default */ }
    return { ok: false, kind: 'validation', message }
  }
  return { ok: false, kind: 'unknown', status: res.status }
}

export async function getGrade(id: string): Promise<GradeSummary | null> {
  const res = await fetch(`/grades/${id}`, { credentials: 'include' })
  if (res.status === 404 || res.status === 403) return null
  if (!res.ok) return null
  return (await res.json()) as GradeSummary
}
