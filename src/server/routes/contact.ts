import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type Redis from 'ioredis'
import type { GradeStore } from '../../store/types.ts'
import type { Mailer } from '../../mail/types.ts'
import { verifyTurnstile } from '../middleware/turnstile.ts'
import { peekBucket, addToBucket, type BucketConfig } from '../middleware/bucket.ts'

// 5 messages per 24h per cookie. Bounded enough that a spammer with unlimited
// cookies would need to cycle them to exceed; we're OK with that for MVP.
const WINDOW_MS = 86_400_000
const LIMIT = 5

function bucketCfg(cookie: string): BucketConfig {
  return { key: `bucket:contact:${cookie}`, limit: LIMIT, windowMs: WINDOW_MS }
}

const ContactBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  category: z.enum(['refund', 'bug', 'feature', 'other']),
  body: z.string().trim().min(10).max(5000),
  turnstileToken: z.string().optional(),
})

export interface ContactRouterDeps {
  store: GradeStore
  redis: Redis
  mailer: Mailer
  turnstileSecretKey?: string | null
}

type Env = { Variables: { cookie: string; clientIp: string; userId: string | null } }

export function contactRouter(deps: ContactRouterDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post(
    '/',
    zValidator('json', ContactBody, (result, c) => {
      if (!result.success) {
        return c.json({ error: 'invalid_body', issues: result.error.issues }, 400)
      }
    }),
    async (c) => {
      const { email, category, body, turnstileToken } = c.req.valid('json')

      const captcha = await verifyTurnstile({
        secretKey: deps.turnstileSecretKey ?? undefined,
        token: turnstileToken,
        remoteIp: c.var.clientIp,
      })
      if (!captcha.ok) {
        return c.json({ error: 'captcha_failed', codes: captcha.errorCodes }, 403)
      }

      // Rate limit: 5 per 24h per cookie
      const cfg = bucketCfg(c.var.cookie)
      const now = Date.now()
      const peek = await peekBucket(deps.redis, cfg, now)
      if (!peek.allowed) {
        return c.json({ error: 'rate_limited', retryAfter: peek.retryAfter }, 429)
      }

      try {
        await deps.mailer.sendContactMessage({ fromEmail: email, category, body })
      } catch (err) {
        console.error('[contact-send-failed]', err)
        return c.json({ error: 'send_failed' }, 502)
      }

      await addToBucket(deps.redis, cfg, now, `contact:${crypto.randomUUID()}`)
      return c.body(null, 204)
    },
  )

  return app
}
