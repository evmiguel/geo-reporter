#!/usr/bin/env tsx
/**
 * One-shot retrofit: find grades that landed in status='failed' while their
 * stripe_payments row is still 'paid' (no auto-refund yet — they predate
 * Plan 15's worker hook) and run autoRefundFailedReport on each.
 *
 * Usage:
 *   pnpm tsx scripts/refund-failed-reports.ts            # apply
 *   pnpm tsx scripts/refund-failed-reports.ts --dry-run  # preview only
 *
 * Idempotent: re-running is safe. Already-refunded grades skip — the helper
 * returns 'skipped_not_paid' when stripe_payments.status is no longer 'paid'.
 */

import { sql } from 'drizzle-orm'
import { env } from '../src/config/env.ts'
import { db, closeDb } from '../src/db/client.ts'
import { PostgresStore } from '../src/store/postgres.ts'
import { createRedis } from '../src/queue/redis.ts'
import { StripeBillingClient } from '../src/billing/stripe-client.ts'
import { ConsoleMailer } from '../src/mail/console-mailer.ts'
import { autoRefundFailedReport } from '../src/queue/workers/generate-report/auto-refund.ts'

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')

  if (!env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is required — refunds hit the live Stripe API.')
    process.exit(1)
  }

  const store = new PostgresStore(db)
  const redis = createRedis(env.REDIS_URL)
  const billing = new StripeBillingClient({ secretKey: env.STRIPE_SECRET_KEY })
  const mailer = new ConsoleMailer()

  // Candidates: grade failed + a paid payment row + no reports row yet.
  // (A reports row means the generation succeeded — never the case for
  // grades we need to retroactively refund.)
  const rows = await db.execute(sql`
    SELECT DISTINCT g.id AS grade_id
    FROM grades g
    INNER JOIN stripe_payments p ON p.grade_id = g.id
    LEFT JOIN reports r ON r.grade_id = g.id
    WHERE g.status = 'failed'
      AND p.status = 'paid'
      AND r.id IS NULL
    ORDER BY g.id
  `)

  console.log(`Found ${rows.length} candidate grade(s)${dryRun ? ' (dry-run)' : ''}`)

  let refunded = 0
  let pending = 0
  let skipped = 0
  for (const row of rows) {
    const gradeId = (row as { grade_id: string }).grade_id
    if (dryRun) {
      console.log('would refund', gradeId)
      continue
    }
    try {
      const result = await autoRefundFailedReport(gradeId, { store, billing, mailer, redis })
      console.log(gradeId, '→', result.kind, result.errorMessage ?? '')
      if (result.kind === 'stripe_refunded' || result.kind === 'credit_granted') {
        refunded++
      } else if (result.kind === 'refund_pending') {
        pending++
      } else {
        skipped++
      }
    } catch (err) {
      console.error(gradeId, '→ fatal:', err)
      pending++
    }
  }

  console.log(`Done. refunded=${refunded} pending=${pending} skipped=${skipped}`)

  await redis.quit()
  await closeDb()
  process.exit(0)
}

main().catch((err) => {
  console.error('refund-failed-reports crashed:', err)
  process.exit(1)
})
