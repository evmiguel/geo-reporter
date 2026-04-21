import type { Job } from 'bullmq'
import type { ReportJob } from '../../queues.ts'
import type { AutoRefundDeps } from './auto-refund.ts'
import { autoRefundFailedReport } from './auto-refund.ts'

/**
 * Inspects a failed BullMQ job. If this was the final attempt (attemptsMade
 * has reached the configured attempts), trigger auto-refund. Earlier failures
 * are no-ops — BullMQ will retry.
 *
 * Lifted out of the worker registration so we can unit-test the dispatch
 * without spinning up a real BullMQ worker + Redis.
 */
export async function handleGenerateReportFailure(
  job: Job<ReportJob>,
  err: Error,
  deps: AutoRefundDeps,
): Promise<void> {
  const attempts = job.opts.attempts ?? 1
  if (job.attemptsMade < attempts) return
  const gradeId = job.data.gradeId
  console.log(JSON.stringify({
    msg: 'generate-report-final-failure',
    gradeId,
    attemptsMade: job.attemptsMade,
    error: err.message,
  }))
  try {
    await autoRefundFailedReport(gradeId, deps)
  } catch (fatal) {
    console.error('[auto-refund-boundary]', gradeId, fatal)
  }
}
