import type { CategoryId, ReportStatusResponse } from './types.ts'

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
  reportId?: string
  reportToken?: string
}

export interface CreateGradeOk { ok: true; gradeId: string }
export interface CreateGradeRateLimited {
  ok: false
  kind: 'rate_limited'
  paywall: 'email' | 'daily_cap'
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
    const body = (await res.json()) as { paywall: 'email' | 'daily_cap'; limit: number; used: number; retryAfter: number }
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

export async function postAuthMagic(email: string, next?: string): Promise<MagicResult> {
  let res: Response
  try {
    const body: { email: string; next?: string } = { email }
    if (next !== undefined) body.next = next
    res = await fetch('/auth/magic', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; kind: 'email_mismatch' | 'not_authenticated' | 'unknown'; status?: number }

export async function postAuthDeleteAccount(email: string): Promise<DeleteAccountResult> {
  let res: Response
  try {
    res = await fetch('/auth/delete-account', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }

  if (res.status === 204) return { ok: true }
  if (res.status === 401) return { ok: false, kind: 'not_authenticated' }
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error === 'email_mismatch') return { ok: false, kind: 'email_mismatch' }
  }
  return { ok: false, kind: 'unknown', status: res.status }
}

export async function getAuthMe(): Promise<{ verified: boolean; email?: string; credits?: number }> {
  const res = await fetch('/auth/me', { credentials: 'include' })
  if (!res.ok) return { verified: false }
  return res.json() as Promise<{ verified: boolean; email?: string; credits?: number }>
}

export interface GradeHistoryEntry {
  id: string
  url: string
  domain: string
  tier: 'free' | 'paid'
  status: 'queued' | 'running' | 'done' | 'failed'
  overall: number | null
  letter: string | null
  createdAt: string
}

export async function listMyGrades(): Promise<GradeHistoryEntry[]> {
  const res = await fetch('/grades', { credentials: 'include' })
  if (res.status === 401 || !res.ok) return []
  const body = await res.json() as { grades: GradeHistoryEntry[] }
  return body.grades
}

export type CheckoutResult =
  | { ok: true; kind: 'checkout'; url: string }
  | { ok: true; kind: 'redeemed' }
  | { ok: false; kind: 'already_paid'; reportId: string }
  | { ok: false; kind: 'grade_not_done' }
  | { ok: false; kind: 'provider_outage' }
  | { ok: false; kind: 'must_verify_email' }
  | { ok: false; kind: 'rate_limited'; retryAfter: number }
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
    const body = await res.json() as { url?: string; redeemed?: boolean }
    // Server short-circuits to credit-redeem when credits > 0 (defense against
    // a stale frontend showing "$19"). No Stripe URL in that case.
    if (body.redeemed === true) return { ok: true, kind: 'redeemed' }
    if (typeof body.url === 'string') return { ok: true, kind: 'checkout', url: body.url }
    return { ok: false, kind: 'unknown', status: 200 }
  }
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retryAfter?: number }
    return { ok: false, kind: 'rate_limited', retryAfter: body.retryAfter ?? 3600 }
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reportId?: string }
    if (body.error === 'already_paid' && typeof body.reportId === 'string') {
      return { ok: false, kind: 'already_paid', reportId: body.reportId }
    }
    if (body.error === 'grade_not_done') return { ok: false, kind: 'grade_not_done' }
    if (body.error === 'provider_outage') return { ok: false, kind: 'provider_outage' }
    if (body.error === 'must_verify_email') return { ok: false, kind: 'must_verify_email' }
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
  | { ok: false; kind: 'already_paid' | 'grade_not_done' | 'provider_outage' | 'no_credits' | 'must_verify_email' | 'unavailable' | 'unknown'; status?: number }

export async function getReportStatus(reportId: string, token: string): Promise<ReportStatusResponse | null> {
  const res = await fetch(`/report/${reportId}/status?t=${encodeURIComponent(token)}`, { credentials: 'same-origin' })
  if (!res.ok) return null
  return (await res.json()) as ReportStatusResponse
}

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
    if (body.error === 'provider_outage') return { ok: false, kind: 'provider_outage' }
    if (body.error === 'no_credits') return { ok: false, kind: 'no_credits' }
    if (body.error === 'must_verify_email') return { ok: false, kind: 'must_verify_email' }
    return { ok: false, kind: 'unknown', status: res.status }
  }
  if (res.status === 503) return { ok: false, kind: 'unavailable' }
  return { ok: false, kind: 'unknown', status: res.status }
}
