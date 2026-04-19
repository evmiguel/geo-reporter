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

export type MagicResult =
  | { ok: true }
  | { ok: false; error: 'invalid_email' | 'rate_limit_email' | 'rate_limit_ip'; retryAfter?: number }

export async function postAuthMagic(email: string): Promise<MagicResult> {
  let res: Response
  try {
    res = await fetch('/auth/magic', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  } catch {
    return { ok: false, error: 'rate_limit_ip' }
  }

  if (res.status === 204) return { ok: true }
  if (res.status === 400) return { ok: false, error: 'invalid_email' }
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { paywall?: string; retryAfter?: number }
    const error = body.paywall === 'email_cooldown' ? 'rate_limit_email' : 'rate_limit_ip'
    return body.retryAfter !== undefined
      ? { ok: false, error, retryAfter: body.retryAfter }
      : { ok: false, error }
  }
  return { ok: false, error: 'rate_limit_ip' }
}

export async function postAuthLogout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
}

export async function getAuthMe(): Promise<{ verified: boolean; email?: string; credits?: number }> {
  const res = await fetch('/auth/me', { credentials: 'include' })
  if (!res.ok) return { verified: false }
  return res.json() as Promise<{ verified: boolean; email?: string; credits?: number }>
}

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; kind: 'already_paid'; reportId: string }
  | { ok: false; kind: 'grade_not_done' }
  | { ok: false; kind: 'unavailable' }
  | { ok: false; kind: 'unknown'; status: number }

export async function postBillingCheckout(gradeId: string): Promise<CheckoutResult> {
  let res: Response
  try {
    res = await fetch('/billing/checkout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gradeId }),
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }

  if (res.status === 200) {
    const body = await res.json() as { url: string }
    return { ok: true, url: body.url }
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reportId?: string }
    if (body.error === 'already_paid' && typeof body.reportId === 'string') {
      return { ok: false, kind: 'already_paid', reportId: body.reportId }
    }
    if (body.error === 'grade_not_done') return { ok: false, kind: 'grade_not_done' }
    return { ok: false, kind: 'unknown', status: res.status }
  }
  if (res.status === 503) return { ok: false, kind: 'unavailable' }
  return { ok: false, kind: 'unknown', status: res.status }
}

export async function postBillingBuyCredits(): Promise<
  | { ok: true; url: string }
  | { ok: false; kind: 'must_verify_email' | 'unavailable' | 'unknown'; status?: number }
> {
  let res: Response
  try {
    res = await fetch('/billing/buy-credits', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }
  if (res.status === 200) {
    const body = await res.json() as { url: string }
    return { ok: true, url: body.url }
  }
  if (res.status === 409) return { ok: false, kind: 'must_verify_email' }
  if (res.status === 503) return { ok: false, kind: 'unavailable' }
  return { ok: false, kind: 'unknown', status: res.status }
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; kind: 'already_paid' | 'grade_not_done' | 'no_credits' | 'must_verify_email' | 'unavailable' | 'unknown'; status?: number }

export async function postBillingRedeemCredit(gradeId: string): Promise<RedeemResult> {
  let res: Response
  try {
    res = await fetch('/billing/redeem-credit', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gradeId }),
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }
  if (res.status === 204) return { ok: true }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error === 'already_paid') return { ok: false, kind: 'already_paid' }
    if (body.error === 'grade_not_done') return { ok: false, kind: 'grade_not_done' }
    if (body.error === 'no_credits') return { ok: false, kind: 'no_credits' }
    if (body.error === 'must_verify_email') return { ok: false, kind: 'must_verify_email' }
    return { ok: false, kind: 'unknown', status: res.status }
  }
  if (res.status === 503) return { ok: false, kind: 'unavailable' }
  return { ok: false, kind: 'unknown', status: res.status }
}
