import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import type { Mailer } from '../../mail/types.ts'
import { COOKIE_NAME } from '../middleware/cookie.ts'
import { verifyTurnstile } from '../middleware/turnstile.ts'
import {
  peekMagicEmailBucket, peekMagicIpBucket,
  addMagicEmailBucket, addMagicIpBucket,
} from '../middleware/auth-rate-limit.ts'

export interface AuthRouterDeps {
  store: GradeStore
  redis: Redis
  mailer: Mailer
  publicBaseUrl: string
  /**
   * When 'development', skip the magic-link rate-limit buckets entirely.
   * Cycling through test emails on localhost would otherwise hit the
   * 5/10min IP cap after a handful of attempts. Production limits unchanged.
   */
  nodeEnv?: 'development' | 'test' | 'production'
  /** Cloudflare Turnstile secret. null disables bot verification (dev). */
  turnstileSecretKey?: string | null
}

type Env = { Variables: { cookie: string; clientIp: string; userId: string | null } }

// `next` is an optional post-verify redirect target. Must be a same-origin
// relative path. Either exactly "/" (root), or starts with "/" followed by a
// non-"/" character (blocks protocol-relative `//evil.com` redirects).
// If absent or invalid, verify falls back to `/?verified=1`.
const NEXT_PATH_RE = /^\/(?:$|[^/])/
const magicSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  next: z.string().regex(NEXT_PATH_RE).max(512).optional(),
  turnstileToken: z.string().optional(),
})

const deleteAccountSchema = z.object({
  email: z.string().trim().toLowerCase(),
})

export function authRouter(deps: AuthRouterDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post(
    '/magic',
    zValidator('json', magicSchema, (result, c) => {
      if (!result.success) {
        // Distinguish "bad email" (the common case, surfaced to user) from
        // "bad next path" (a frontend bug — still 400 but different code).
        const failedOnEmail = result.error.issues.some((i) => i.path[0] === 'email')
        return c.json({ error: failedOnEmail ? 'invalid_email' : 'invalid_body' }, 400)
      }
    }),
    async (c) => {
      const { email, next, turnstileToken } = c.req.valid('json')
      const ip = c.var.clientIp
      const skipRateLimit = deps.nodeEnv === 'development'

      const captcha = await verifyTurnstile({
        secretKey: deps.turnstileSecretKey ?? undefined,
        token: turnstileToken,
        remoteIp: ip,
      })
      if (!captcha.ok) {
        return c.json({ error: 'captcha_failed', codes: captcha.errorCodes }, 403)
      }

      if (!skipRateLimit) {
        const emailPeek = await peekMagicEmailBucket(deps.redis, email)
        if (!emailPeek.allowed) {
          return c.json({
            paywall: 'email_cooldown' as const,
            limit: emailPeek.limit,
            used: emailPeek.used,
            retryAfter: emailPeek.retryAfter,
          }, 429)
        }

        const ipPeek = await peekMagicIpBucket(deps.redis, ip)
        if (!ipPeek.allowed) {
          return c.json({
            paywall: 'ip_cooldown' as const,
            limit: ipPeek.limit,
            used: ipPeek.used,
            retryAfter: ipPeek.retryAfter,
          }, 429)
        }
      }

      const { rawToken, expiresAt } = await deps.store.issueMagicToken(email, c.var.cookie)
      const nextParam = next !== undefined ? `&next=${encodeURIComponent(next)}` : ''
      const url = `${deps.publicBaseUrl}/auth/verify?t=${rawToken}${nextParam}`
      await deps.mailer.sendMagicLink({ email, url, expiresAt })

      if (!skipRateLimit) {
        await addMagicEmailBucket(deps.redis, email)
        await addMagicIpBucket(deps.redis, ip)
      }

      return c.body(null, 204)
    },
  )

  app.get('/verify', async (c) => {
    const t = c.req.query('t')
    if (!t || !/^[A-Za-z0-9_-]+$/.test(t)) return c.redirect('/?auth_error=expired_or_invalid', 302)
    const tokenHash = createHash('sha256').update(t).digest('hex')
    const result = await deps.store.consumeMagicToken(tokenHash, c.var.cookie)
    if (!result.ok) return c.redirect('/?auth_error=expired_or_invalid', 302)
    // Honor `next` for preserve-intent (e.g. magic-link click resumes a paid
    // checkout flow on the original grade page). Validated as a same-origin
    // relative path; falls back to /?verified=1 on absence or mismatch.
    const next = c.req.query('next')
    if (next !== undefined && NEXT_PATH_RE.test(next) && next.length <= 512) {
      const sep = next.includes('?') ? '&' : '?'
      return c.redirect(`${next}${sep}verified=1`, 302)
    }
    return c.redirect('/?verified=1', 302)
  })

  app.post('/logout', async (c) => {
    await deps.store.unbindCookie(c.var.cookie)
    return c.body(null, 204)
  })

  app.post(
    '/delete-account',
    zValidator('json', deleteAccountSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_body' }, 400)
    }),
    async (c) => {
      const { email } = c.req.valid('json')
      const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
      if (row.userId === null || row.email === null) {
        return c.json({ error: 'not_authenticated' }, 401)
      }
      if (row.email.toLowerCase() !== email) {
        return c.json({ error: 'email_mismatch' }, 400)
      }

      await deps.store.deleteUser(row.userId, email)

      // Clear the cookie so the browser treats the next request as a fresh session.
      setCookie(c, COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'Lax',
        secure: deps.nodeEnv === 'production',
        path: '/',
        maxAge: 0,
      })
      return c.body(null, 204)
    },
  )

  app.get('/me', async (c) => {
    const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
    // Never cache auth state — a stale verified:true after logout leaves the
    // Header showing signed-in UI even though the server cleared the binding.
    c.header('Cache-Control', 'no-store')
    if (row.userId && row.email) {
      return c.json({ verified: true, email: row.email, credits: row.credits })
    }
    return c.json({ verified: false })
  })

  return app
}
