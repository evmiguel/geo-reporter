import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { enqueueGrade } from '../../queue/queues.ts'
import { commitRateLimit } from '../middleware/rate-limit.ts'
import { isOwnedBy } from '../lib/grade-ownership.ts'
import type { ServerDeps } from '../deps.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CreateGradeBody = z.object({
  url: z.string().url().refine(
    (u) => {
      try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:' } catch { return false }
    },
    { message: 'url must be http:// or https://' },
  ),
})

type Env = { Variables: { cookie: string; clientIp: string; userId: string | null } }

export function gradesRouter(deps: ServerDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post('/', zValidator('json', CreateGradeBody), async (c) => {
    const { url } = c.req.valid('json')
    const parsed = new URL(url)
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const grade = await deps.store.createGrade({
      url, domain, tier: 'free', cookie: c.var.cookie, userId: null, status: 'queued',
    })
    await commitRateLimit(deps.redis, deps.store, c.var.clientIp, c.var.cookie, grade.id)
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
