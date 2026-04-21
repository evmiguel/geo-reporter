import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { enqueueGrade } from '../../queue/queues.ts'
import { commitRateLimit } from '../middleware/rate-limit.ts'
import { isOwnedBy } from '../lib/grade-ownership.ts'
import { verifyTurnstile } from '../middleware/turnstile.ts'
import type { ServerDeps } from '../deps.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Accepts bare domains (`example.com`) and auto-prefixes `https://` before
// validating. Users don't have to type the scheme.
const CreateGradeBody = z.object({
  url: z.string().trim().min(1).transform((raw, ctx) => {
    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    try {
      const parsed = new URL(normalized)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: 'url must be http:// or https://' })
        return z.NEVER
      }
      if (parsed.hostname.length === 0 || !parsed.hostname.includes('.')) {
        ctx.addIssue({ code: 'custom', message: 'url must include a valid domain' })
        return z.NEVER
      }
      return normalized
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid URL' })
      return z.NEVER
    }
  }),
  turnstileToken: z.string().optional(),
})

type Env = { Variables: { cookie: string; clientIp: string; userId: string | null } }

export function gradesRouter(deps: ServerDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post('/', zValidator('json', CreateGradeBody), async (c) => {
    const { url, turnstileToken } = c.req.valid('json')
    const captcha = await verifyTurnstile({
      secretKey: deps.env.TURNSTILE_SECRET_KEY ?? undefined,
      token: turnstileToken,
      remoteIp: c.var.clientIp,
    })
    if (!captcha.ok) {
      return c.json({ error: 'captcha_failed', codes: captcha.errorCodes }, 403)
    }
    const parsed = new URL(url)
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const grade = await deps.store.createGrade({
      url, domain, tier: 'free', cookie: c.var.cookie, userId: c.var.userId, status: 'queued',
    })
    await commitRateLimit(deps.redis, deps.store, c.var.clientIp, c.var.cookie, grade.id)
    await enqueueGrade(
      { gradeId: grade.id, tier: 'free', ip: c.var.clientIp, cookie: c.var.cookie },
      deps.redis,
    )
    return c.json({ gradeId: grade.id }, 202)
  })

  // Credit overflow: when the free 2/day is exhausted, a verified user with
  // credits can spend one to run an additional grade. The grade runs as free
  // tier first (2-provider scoring, same fast pipeline); the worker then
  // auto-enqueues generate-report because a paid stripe_payments row exists,
  // upgrading it to the full 4-provider report + recommendations + PDF.
  //
  // Bypasses the rate limit (doesn't commit to any bucket). If the user has
  // no credits, returns 409 no_credits; if not verified, returns 409
  // must_verify_email.
  app.post('/redeem', zValidator('json', CreateGradeBody), async (c) => {
    const { url, turnstileToken } = c.req.valid('json')
    if (c.var.userId === null) {
      return c.json({ error: 'must_verify_email' }, 409)
    }
    const captcha = await verifyTurnstile({
      secretKey: deps.env.TURNSTILE_SECRET_KEY ?? undefined,
      token: turnstileToken,
      remoteIp: c.var.clientIp,
    })
    if (!captcha.ok) {
      return c.json({ error: 'captcha_failed', codes: captcha.errorCodes }, 403)
    }

    const redeem = await deps.store.redeemCredit(c.var.userId)
    if (!redeem.ok) return c.json({ error: 'no_credits' }, 409)

    const parsed = new URL(url)
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const grade = await deps.store.createGrade({
      url, domain, tier: 'free', cookie: c.var.cookie, userId: c.var.userId, status: 'queued',
    })

    // Audit row: same shape as /billing/redeem-credit writes after an
    // already-done grade. run-grade's worker auto-enqueues generate-report
    // when it sees a paid stripe_payments row on completion, so this flip
    // is what triggers the paid-report pipeline (4-provider + recs + PDF).
    const auditSessionId = `credit:${grade.id}`
    await deps.store.createStripePayment({
      gradeId: grade.id, sessionId: auditSessionId,
      amountCents: 0, currency: 'usd', kind: 'credits',
      userId: c.var.userId,
    })
    await deps.store.updateStripePaymentStatus(auditSessionId, { status: 'paid' })

    await enqueueGrade(
      { gradeId: grade.id, tier: 'free', ip: c.var.clientIp, cookie: c.var.cookie },
      deps.redis,
    )
    return c.json({ gradeId: grade.id }, 202)
  })

  app.get('/', async (c) => {
    if (c.var.userId === null) {
      return c.json({ error: 'must_verify_email' }, 401)
    }
    const grades = await deps.store.listGradesByUser(c.var.userId, 50)
    return c.json({
      grades: grades.map((g) => ({
        id: g.id,
        url: g.url,
        domain: g.domain,
        tier: g.tier,
        status: g.status,
        overall: g.overall,
        letter: g.letter,
        createdAt: g.createdAt.toISOString(),
      })),
    })
  })

  app.get('/:id', async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400)
    const grade = await deps.store.getGrade(id)
    if (!grade) return c.json({ error: 'not found' }, 404)
    if (!isOwnedBy(grade, { cookie: c.var.cookie, userId: c.var.userId })) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const body: Record<string, unknown> = {
      id: grade.id,
      url: grade.url,
      domain: grade.domain,
      tier: grade.tier,
      status: grade.status,
      overall: grade.overall,
      letter: grade.letter,
      scores: grade.scores,
      createdAt: grade.createdAt,
      updatedAt: grade.updatedAt,
    }
    // Payment lookup covers two cases the client needs to hydrate from a refresh:
    //  (a) tier === 'paid' AND report row present  → show "ready" + View/PDF links
    //  (b) stripe_payments has a paid row but grade.tier is still 'free' and
    //      report row not yet written → generation is in flight; show "generating"
    //      (the worker flips tier=paid LAST, so this window can last 30-60s).
    const payments = await deps.store.listStripePaymentsByGrade(grade.id)
    const paymentPaid = payments.some((p) => p.status === 'paid')
    body.paymentPaid = paymentPaid
    if (paymentPaid) {
      const report = await deps.store.getReport(grade.id)
      if (report) {
        body.reportId = report.id
        body.reportToken = report.token
      }
    }
    return c.json(body)
  })

  return app
}
