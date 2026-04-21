import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Queue } from 'bullmq'
import type Redis from 'ioredis'
import type { BillingClient } from '../../billing/types.ts'
import { PRICE_AMOUNT_CENTS, PRICE_CURRENCY } from '../../billing/prices.ts'
import type { GradeStore } from '../../store/types.ts'
import type { ReportJob } from '../../queue/queues.ts'
import { peekBucket, addToBucket } from '../middleware/bucket.ts'
import { isOwnedBy } from '../lib/grade-ownership.ts'

export interface BillingRouterDeps {
  store: GradeStore
  billing: BillingClient
  redis: Redis
  priceId: string
  creditsPriceId: string   // NEW — can be '' when not configured
  publicBaseUrl: string
  webhookSecret: string
  reportQueue: Queue<ReportJob>
}

type Env = { Variables: { cookie: string; clientIp: string; userId: string | null } }

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

      // Per-cookie rate limit: prevents a malicious cookie-holder from hammering
      // /checkout and flooding the stripe_payments table with pending rows.
      // 10 attempts per cookie per rolling hour.
      const bucketCfg = {
        key: `bucket:checkout:${c.var.cookie}`,
        limit: 10,
        windowMs: 3_600_000,
      }
      const peek = await peekBucket(deps.redis, bucketCfg, Date.now())
      if (!peek.allowed) {
        return c.json({
          error: 'rate_limited' as const,
          paywall: 'checkout_throttled' as const,
          retryAfter: peek.retryAfter,
        }, 429)
      }
      await addToBucket(deps.redis, bucketCfg, Date.now(), `checkout:${crypto.randomUUID()}`)

      const grade = await deps.store.getGrade(gradeId)
      if (!grade) return c.json({ error: 'not_found' }, 404)
      if (!isOwnedBy(grade, { cookie: c.var.cookie, userId: c.var.userId })) {
        return c.json({ error: 'not_found' }, 404)
      }
      if (grade.status !== 'done') return c.json({ error: 'grade_not_done' }, 409)

      // Require email verification before $19 checkout so the report stays
      // accessible if the user clears cookies or switches devices. Stripe alone
      // ties the purchase to the cookie+grade only — without a user binding,
      // the report is effectively orphaned.
      const cookieRow = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
      if (!cookieRow.userId) return c.json({ error: 'must_verify_email' }, 409)

      // Plan 12: block checkout when the underlying free grade had Claude/GPT
      // terminal probe failures — the report is incomplete, so refuse both the
      // $19 Stripe path and the server-side credit redemption below. Placed
      // BEFORE `already_paid`, the credit short-circuit, and Stripe session
      // creation so no side effect fires on the reject path; AFTER the auth +
      // ownership + `grade_not_done` checks so we only gate settled grades the
      // caller actually owns.
      if (await deps.store.hasTerminalProviderFailures(grade.id)) {
        return c.json({ error: 'provider_outage' }, 409)
      }

      const payments = await deps.store.listStripePaymentsByGrade(gradeId)
      const paid = payments.find((p) => p.status === 'paid')
      if (paid) return c.json({ error: 'already_paid', reportId: grade.id }, 409)

      // Defense-in-depth: if the user already has credits, spend one instead
      // of charging $19. The frontend button normally shows "Redeem credit"
      // in this case, but a stale useAuth() state (e.g. race right after
      // purchase) could still present "$19". Never charge a user who's already
      // paying — always prefer the credit.
      if (cookieRow.credits > 0) {
        const redeem = await deps.store.redeemCredit(cookieRow.userId)
        if (redeem.ok) {
          const auditSessionId = `credit:${gradeId}`
          await deps.store.createStripePayment({
            gradeId, sessionId: auditSessionId,
            amountCents: 0, currency: 'usd', kind: 'credits',
            userId: cookieRow.userId,
          })
          await deps.store.updateStripePaymentStatus(auditSessionId, { status: 'paid' })
          const jobId = `generate-report-credit-${gradeId}`
          await deps.reportQueue.add(
            'generate-report',
            { gradeId, sessionId: auditSessionId },
            { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
          )
          return c.json({ redeemed: true })
        }
        // redeem.ok === false means a concurrent redemption drained the last
        // credit between our read and the decrement. Fall through to Stripe —
        // the user did click "buy", so charging them is the correct fallback.
      }

      const pending = payments.find((p) => p.status === 'pending')
      if (pending) {
        const remote = await deps.billing.retrieveCheckoutSession(pending.sessionId)
        if (remote.status === 'open') {
          return c.json({ url: remote.url })
        }
        await deps.store.updateStripePaymentStatus(pending.sessionId, { status: 'failed' })
      }

      const session = await deps.billing.createCheckoutSession({
        kind: 'report',
        gradeId,
        priceId: deps.priceId,
        successUrl: `${deps.publicBaseUrl}/g/${gradeId}?checkout=complete`,
        cancelUrl: `${deps.publicBaseUrl}/g/${gradeId}?checkout=canceled`,
      })
      await deps.store.createStripePayment({
        gradeId, sessionId: session.id,
        amountCents: PRICE_AMOUNT_CENTS, currency: PRICE_CURRENCY,
        userId: cookieRow.userId,
      })
      return c.json({ url: session.url })
    },
  )

  app.post('/buy-credits', async (c) => {
    // Per-cookie rate limit: 10/h. Mirrors /checkout — without this a cookie
    // could spam pending credits rows into stripe_payments.
    const bucketCfg = {
      key: `bucket:buy-credits:${c.var.cookie}`,
      limit: 10,
      windowMs: 3_600_000,
    }
    const peek = await peekBucket(deps.redis, bucketCfg, Date.now())
    if (!peek.allowed) {
      return c.json({
        error: 'rate_limited' as const,
        paywall: 'buy_credits_throttled' as const,
        retryAfter: peek.retryAfter,
      }, 429)
    }
    await addToBucket(deps.redis, bucketCfg, Date.now(), `buy-credits:${crypto.randomUUID()}`)

    if (!deps.creditsPriceId) {
      return c.json({ error: 'stripe_credits_not_configured' }, 503)
    }
    const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
    if (!row.userId) {
      return c.json({ error: 'must_verify_email' }, 409)
    }
    const session = await deps.billing.createCheckoutSession({
      kind: 'credits',
      userId: row.userId,
      priceId: deps.creditsPriceId,
      successUrl: `${deps.publicBaseUrl}/?credits=purchased`,
      cancelUrl: `${deps.publicBaseUrl}/?credits=canceled`,
    })
    await deps.store.createStripePayment({
      gradeId: null,
      sessionId: session.id,
      amountCents: 2900,
      currency: 'usd',
      kind: 'credits',
      userId: row.userId,
    })
    return c.json({ url: session.url })
  })

  app.post(
    '/redeem-credit',
    zValidator('json', checkoutSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_body' }, 400)
    }),
    async (c) => {
      // Per-cookie rate limit: 10/h. Sits in front of ownership/credit checks
      // so a cookie spamming redeem-credit can't pound the DB with lookups.
      const bucketCfg = {
        key: `bucket:redeem-credit:${c.var.cookie}`,
        limit: 10,
        windowMs: 3_600_000,
      }
      const peek = await peekBucket(deps.redis, bucketCfg, Date.now())
      if (!peek.allowed) {
        return c.json({
          error: 'rate_limited' as const,
          paywall: 'redeem_credit_throttled' as const,
          retryAfter: peek.retryAfter,
        }, 429)
      }
      await addToBucket(deps.redis, bucketCfg, Date.now(), `redeem-credit:${crypto.randomUUID()}`)

      const { gradeId } = c.req.valid('json')
      const grade = await deps.store.getGrade(gradeId)
      if (!grade) return c.json({ error: 'not_found' }, 404)
      if (!isOwnedBy(grade, { cookie: c.var.cookie, userId: c.var.userId })) {
        return c.json({ error: 'not_found' }, 404)
      }
      if (grade.status !== 'done') return c.json({ error: 'grade_not_done' }, 409)

      // Plan 12: block unlock when the underlying free grade had Claude/GPT
      // terminal probe failures — the report is incomplete, so don't let
      // the user spend a credit on a dud. Placed BEFORE `already_paid` so
      // we never leak paid state, and AFTER `grade_not_done` so we only
      // check settled grades.
      if (await deps.store.hasTerminalProviderFailures(grade.id)) {
        return c.json({ error: 'provider_outage' }, 409)
      }

      const payments = await deps.store.listStripePaymentsByGrade(gradeId)
      if (payments.some((p) => p.status === 'paid')) {
        return c.json({ error: 'already_paid', reportId: grade.id }, 409)
      }

      const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
      if (!row.userId) return c.json({ error: 'must_verify_email' }, 409)

      const redeem = await deps.store.redeemCredit(row.userId)
      if (!redeem.ok) return c.json({ error: 'no_credits' }, 409)

      const auditSessionId = `credit:${gradeId}`
      await deps.store.createStripePayment({
        gradeId, sessionId: auditSessionId,
        amountCents: 0, currency: 'usd', kind: 'credits',
        userId: row.userId,
      })
      await deps.store.updateStripePaymentStatus(auditSessionId, { status: 'paid' })

      // BullMQ rejects colons in custom job IDs, so derive a safe jobId from the
      // gradeId. The sessionId in the job data still carries the full colon-form
      // audit string; only the deterministic jobId is sanitized.
      const jobId = `generate-report-credit-${gradeId}`
      await deps.reportQueue.add(
        'generate-report',
        { gradeId, sessionId: auditSessionId },
        { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      )

      return c.body(null, 204)
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

    const sessionId = event.data.object.id
    const metadata = event.data.object.metadata ?? {}
    const row = await deps.store.getStripePaymentBySessionId(sessionId)
    if (!row) return c.json({ error: 'unknown_session' }, 400)

    const amountCents = event.data.object.amount_total
    const currency = event.data.object.currency

    // Branch on row.kind (DB source of truth; metadata.kind is informational)
    if (row.kind === 'credits') {
      // Credits grants are one-shot — short-circuit on already-paid to avoid double-grant.
      if (row.status === 'paid') {
        return c.body(null, 200)   // idempotent
      }
      const userId = metadata.userId
      const creditCount = Number(metadata.creditCount ?? 0)
      if (!userId || !Number.isInteger(creditCount) || creditCount < 1) {
        return c.json({ error: 'malformed_credits_metadata' }, 400)
      }
      await deps.store.grantCreditsAndMarkPaid(
        sessionId, userId, creditCount,
        typeof amountCents === 'number' ? amountCents : row.amountCents,
        typeof currency === 'string' ? currency : row.currency,
      )
      return c.body(null, 200)
    }

    // Default (report) path — ALWAYS attempt enqueue (BullMQ dedups by jobId).
    // This closes the race where the webhook flipped status → 'paid' but
    // crashed before reportQueue.add ran; on Stripe's retry we re-enqueue,
    // and the deterministic jobId ensures a single job is created.
    const gradeId = metadata.gradeId
    if (!gradeId || !UUID_REGEX.test(gradeId)) {
      return c.json({ error: 'missing_grade_id' }, 400)
    }
    if (row.status !== 'paid') {
      await deps.store.updateStripePaymentStatus(sessionId, {
        status: 'paid',
        ...(typeof amountCents === 'number' ? { amountCents } : {}),
        ...(typeof currency === 'string' ? { currency } : {}),
      })
    }
    await deps.reportQueue.add(
      'generate-report',
      { gradeId, sessionId },
      { jobId: `generate-report-${sessionId}`, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
    )
    return c.body(null, 200)
  })

  return app
}
