import type Redis from 'ioredis'
import type { GradeStore } from '../../../store/types.ts'
import type { BillingClient } from '../../../billing/types.ts'
import type { Mailer } from '../../../mail/types.ts'
import { publishGradeEvent } from '../../events.ts'

export interface AutoRefundDeps {
  store: GradeStore
  billing: BillingClient
  mailer: Mailer
  redis: Redis
}

export interface AutoRefundResult {
  kind: 'skipped_not_paid' | 'stripe_refunded' | 'credit_granted' | 'refund_pending'
  errorMessage?: string
}

/**
 * Auto-refund a failed paid-report grade. Idempotent: re-running on a grade whose
 * stripe_payments row is already `'refunded'` is a no-op (`'skipped_not_paid'`).
 *
 * Branch on `payment.kind`:
 * - `'report'`: call `billing.refund(sessionId)`. On success → status='refunded',
 *   publish SSE, email user. On failure → status='refund_pending', loud log, no email
 *   (so the user doesn't get a confusing "processing" notice — operator resolves).
 * - `'credits'`: increment the user's credit balance by 1, flip audit row to
 *   'refunded', publish SSE, email user. No Stripe call.
 *
 * Email send failures are caught and logged — we never want to revert a successful
 * refund because of a mailer blip.
 */
export async function autoRefundFailedReport(
  gradeId: string,
  deps: AutoRefundDeps,
): Promise<AutoRefundResult> {
  const payments = await deps.store.listStripePaymentsByGrade(gradeId)
  const paid = payments.find((p) => p.status === 'paid')
  if (!paid) return { kind: 'skipped_not_paid' }

  const grade = await deps.store.getGrade(gradeId)
  if (!grade) return { kind: 'skipped_not_paid' }

  // Look up the user's email for the refund notice. Best-effort — if the cookie
  // lookup fails or there's no bound user, we still complete the refund.
  let userEmail: string | null = null
  if (grade.cookie) {
    try {
      const cookieRow = await deps.store.getCookieWithUserAndCredits(grade.cookie)
      userEmail = cookieRow.email
    } catch {
      // swallow — email is best-effort
    }
  }

  if (paid.kind === 'report') {
    const refund = await deps.billing.refund(paid.sessionId)
    if (!refund.ok) {
      await deps.store.updateStripePaymentStatus(paid.sessionId, { status: 'refund_pending' })
      console.error('[auto-refund-failed]', gradeId, paid.sessionId, refund.errorMessage)
      return {
        kind: 'refund_pending',
        errorMessage: refund.errorMessage ?? 'unknown stripe error',
      }
    }
    await deps.store.updateStripePaymentStatus(paid.sessionId, { status: 'refunded' })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'report.refunded',
      refundKind: 'stripe',
    })
    if (userEmail) {
      try {
        await deps.mailer.sendRefundNotice({
          to: userEmail,
          domain: grade.domain,
          kind: 'stripe',
        })
      } catch (err) {
        console.error('[auto-refund-email-failed]', gradeId, err)
      }
    }
    return { kind: 'stripe_refunded' }
  }

  // kind === 'credits' — audit row from /billing/redeem-credit. Grant a credit back.
  if (paid.kind === 'credits' && grade.userId) {
    try {
      await deps.store.incrementCredits(grade.userId, 1)
    } catch (err) {
      console.error('[auto-refund-credit-failed]', gradeId, err)
      await deps.store.updateStripePaymentStatus(paid.sessionId, { status: 'refund_pending' })
      return {
        kind: 'refund_pending',
        errorMessage: err instanceof Error ? err.message : String(err),
      }
    }
    await deps.store.updateStripePaymentStatus(paid.sessionId, { status: 'refunded' })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'report.refunded',
      refundKind: 'credit',
    })
    if (userEmail) {
      try {
        await deps.mailer.sendRefundNotice({
          to: userEmail,
          domain: grade.domain,
          kind: 'credit',
        })
      } catch (err) {
        console.error('[auto-refund-email-failed]', gradeId, err)
      }
    }
    return { kind: 'credit_granted' }
  }

  return { kind: 'skipped_not_paid' }
}
