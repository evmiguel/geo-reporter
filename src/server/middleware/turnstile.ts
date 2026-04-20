/**
 * Cloudflare Turnstile server-side verification.
 *
 * The client submits a token produced by the widget. We POST it (with the
 * user's IP and our secret) to Cloudflare's siteverify endpoint; a truthy
 * `success` means the token was valid. Tokens are single-use and expire
 * after 300 seconds, so verify once per submission.
 *
 * Dev fallback: when `secretKey` is missing (empty/undefined) the verifier
 * returns `true` unconditionally and logs a one-time warning. Prevents
 * blocking local development without a real Cloudflare account.
 *
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

let missingSecretWarned = false

export interface VerifyTurnstileOptions {
  secretKey: string | undefined
  token: string | undefined
  remoteIp?: string
  fetchFn?: typeof globalThis.fetch
}

export interface VerifyTurnstileResult {
  ok: boolean
  /** error code(s) from Cloudflare, for logging. Empty when ok=true or dev-skip. */
  errorCodes: string[]
  /** true when no secret is configured and we short-circuit to allow. */
  skipped: boolean
}

export async function verifyTurnstile(opts: VerifyTurnstileOptions): Promise<VerifyTurnstileResult> {
  const { secretKey, token, remoteIp } = opts
  const fetchFn = opts.fetchFn ?? globalThis.fetch

  if (!secretKey || secretKey.length === 0) {
    if (!missingSecretWarned) {
      console.warn('[turnstile] TURNSTILE_SECRET_KEY unset — skipping bot verification (dev only).')
      missingSecretWarned = true
    }
    return { ok: true, errorCodes: [], skipped: true }
  }

  if (!token || token.length === 0) {
    return { ok: false, errorCodes: ['missing-input-response'], skipped: false }
  }

  const body = new URLSearchParams({ secret: secretKey, response: token })
  if (remoteIp !== undefined && remoteIp.length > 0) body.set('remoteip', remoteIp)

  let res: Response
  try {
    res = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch {
    // Network failure talking to Cloudflare. Treating as bot-detected is
    // safer than open-fail: if CF is unreachable we can't distinguish
    // legitimate users from bots. Surfaces as the same 403 as a real fail.
    return { ok: false, errorCodes: ['network-error'], skipped: false }
  }

  if (!res.ok) {
    return { ok: false, errorCodes: [`http-${res.status}`], skipped: false }
  }

  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean
    'error-codes'?: string[]
  }
  if (data.success === true) return { ok: true, errorCodes: [], skipped: false }
  return { ok: false, errorCodes: data['error-codes'] ?? ['unknown'], skipped: false }
}
