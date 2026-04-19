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
}

type Env = { Variables: { cookie: string; clientIp: string } }

const magicSchema = z.object({ email: z.string().trim().toLowerCase().email() })

export function authRouter(deps: AuthRouterDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post(
    '/magic',
    zValidator('json', magicSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_email' }, 400)
    }),
    async (c) => {
      const { email } = c.req.valid('json')
      const ip = c.var.clientIp

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

      const { rawToken, expiresAt } = await deps.store.issueMagicToken(email, c.var.cookie)
      const url = `${deps.publicBaseUrl}/auth/verify?t=${rawToken}`
      await deps.mailer.sendMagicLink({ email, url, expiresAt })

      await addMagicEmailBucket(deps.redis, email)
      await addMagicIpBucket(deps.redis, ip)

      return c.body(null, 204)
    },
  )

  app.get('/verify', async (c) => {
    const t = c.req.query('t')
    if (!t || !/^[A-Za-z0-9_-]+$/.test(t)) return c.redirect('/?auth_error=expired_or_invalid', 302)
    const tokenHash = createHash('sha256').update(t).digest('hex')
    const result = await deps.store.consumeMagicToken(tokenHash, c.var.cookie)
    if (!result.ok) return c.redirect('/?auth_error=expired_or_invalid', 302)
    return c.redirect('/?verified=1', 302)
  })

  return app
}
