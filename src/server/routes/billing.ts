import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Queue } from 'bullmq'
import type { BillingClient } from '../../billing/types.ts'
import { PRICE_AMOUNT_CENTS, PRICE_CURRENCY } from '../../billing/prices.ts'
import type { GradeStore } from '../../store/types.ts'
import type { ReportJob } from '../../queue/queues.ts'

export interface BillingRouterDeps {
  store: GradeStore
  billing: BillingClient
  priceId: string
  publicBaseUrl: string
  webhookSecret: string
  reportQueue: Queue<ReportJob>
}

type Env = { Variables: { cookie: string; clientIp: string } }

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const checkoutSchema = z.object({ gradeId: z.string().regex(UUID_REGEX) })

export function billingRouter(deps: BillingRouterDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.post(
    '/checkout',
    zValidator('json', checkoutSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_body' }, 400)
    }),
    async (c) => {
      const { gradeId } = c.req.valid('json')
      const grade = await deps.store.getGrade(gradeId)
      if (!grade) return c.json({ error: 'not_found' }, 404)
      if (grade.cookie !== c.var.cookie) return c.json({ error: 'not_found' }, 404)
      if (grade.status !== 'done') return c.json({ error: 'grade_not_done' }, 409)

      const payments = await deps.store.listStripePaymentsByGrade(gradeId)
      const paid = payments.find((p) => p.status === 'paid')
      if (paid) return c.json({ error: 'already_paid', reportId: grade.id }, 409)

      const pending = payments.find((p) => p.status === 'pending')
      if (pending) {
        const remote = await deps.billing.retrieveCheckoutSession(pending.sessionId)
        if (remote.status === 'open') {
          return c.json({ url: remote.url })
        }
        await deps.store.updateStripePaymentStatus(pending.sessionId, { status: 'failed' })
      }

      const session = await deps.billing.createCheckoutSession({
        gradeId,
        priceId: deps.priceId,
        successUrl: `${deps.publicBaseUrl}/g/${gradeId}?checkout=complete`,
        cancelUrl: `${deps.publicBaseUrl}/g/${gradeId}?checkout=canceled`,
      })
      await deps.store.createStripePayment({
        gradeId, sessionId: session.id,
        amountCents: PRICE_AMOUNT_CENTS, currency: PRICE_CURRENCY,
      })
      return c.json({ url: session.url })
    },
  )

  app.post('/webhook', async (c) => {
    const rawBuffer = await c.req.raw.arrayBuffer()
    const rawBody = new TextDecoder().decode(rawBuffer)
    const signature = c.req.header('stripe-signature')
    if (!signature) return c.json({ error: 'missing_signature' }, 400)

    let event
    try {
      event = deps.billing.verifyWebhookSignature(rawBody, signature, deps.webhookSecret)
    } catch {
      return c.json({ error: 'invalid_signature' }, 400)
    }

    if (event.type !== 'checkout.session.completed') {
      return c.body(null, 200)
    }

    const gradeId = event.data.object.metadata?.gradeId
    if (!gradeId || !UUID_REGEX.test(gradeId)) {
      return c.json({ error: 'missing_grade_id' }, 400)
    }

    const sessionId = event.data.object.id
    const row = await deps.store.getStripePaymentBySessionId(sessionId)
    if (!row) return c.json({ error: 'unknown_session' }, 400)
    if (row.status === 'paid') {
      return c.body(null, 200)
    }

    const amountCents = event.data.object.amount_total
    const currency = event.data.object.currency
    await deps.store.updateStripePaymentStatus(sessionId, {
      status: 'paid',
      ...(typeof amountCents === 'number' ? { amountCents } : {}),
      ...(typeof currency === 'string' ? { currency } : {}),
    })

    await deps.reportQueue.add(
      'generate-report',
      { gradeId, sessionId },
      { jobId: `generate-report-${sessionId}`, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
    )

    return c.body(null, 200)
  })

  return app
}
