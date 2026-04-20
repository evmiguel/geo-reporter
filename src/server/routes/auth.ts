import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import type { Mailer } from '../../mail/types.ts'
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
}

type Env = { Variables: { cookie: string; clientIp: string } }

// `next` is an optional post-verify redirect target. Must be a same-origin
// relative path (starts with `/` followed by non-`/` to block `//evil.com`).
// If absent or invalid, verify falls back to `/?verified=1`.
const NEXT_PATH_RE = /^\/[^/]/
const magicSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  next: z.string().regex(NEXT_PATH_RE).max(512).optional(),
})

export function authRouter(deps: AuthRouterDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post(
    '/magic',
    zValidator('json', magicSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_email' }, 400)
    }),
    async (c) => {
      const { email, next } = c.req.valid('json')
      const ip = c.var.clientIp
      const skipRateLimit = deps.nodeEnv === 'development'

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

  app.get('/me', async (c) => {
    const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
    if (row.userId && row.email) {
      return c.json({ verified: true, email: row.email, credits: row.credits })
    }
    return c.json({ verified: false })
  })

  return app
}
