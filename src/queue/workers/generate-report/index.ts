import { Worker } from 'bullmq'
import type Redis from 'ioredis'
import { enqueuePdf, reportQueueName, type PdfJob, type ReportJob } from '../../queues.ts'
import { generateReport, type GenerateReportJob } from './generate-report.ts'
import { runRecommender } from './recommender.ts'
import { handleGenerateReportFailure } from './failed-listener.ts'
import type { GenerateReportDeps } from './deps.ts'

type JobDataInput = Pick<GenerateReportJob, 'gradeId' | 'sessionId'>

export function registerGenerateReportWorker(
  deps: Omit<GenerateReportDeps, 'recommenderFn' | 'enqueuePdfFn'>,
  connection: Redis,
): Worker<ReportJob> {
  const enqueuePdfFn = (job: PdfJob): Promise<void> => enqueuePdf(job, connection)
  const fullDeps: GenerateReportDeps = { ...deps, recommenderFn: runRecommender, enqueuePdfFn }
  const worker = new Worker<ReportJob>(
    reportQueueName,
    async (job) => {
      const data = job.data as JobDataInput
      if (!data.sessionId) throw new Error('generate-report: missing sessionId on job data')
      await generateReport(fullDeps, { gradeId: data.gradeId, sessionId: data.sessionId })
    },
    { connection, concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    if (!job) return
    if (!fullDeps.billing) {
      // Auto-refund requires a BillingClient for Stripe refunds. Credit-kind
      // refunds could theoretically run without Stripe, but to keep this path
      // predictable in dev we skip entirely and loud-log so operators notice.
      console.warn(JSON.stringify({
        msg: 'auto-refund-skipped-no-billing',
        gradeId: job.data.gradeId,
        attemptsMade: job.attemptsMade,
      }))
      return
    }
    void handleGenerateReportFailure(job, err, {
      store: fullDeps.store,
      billing: fullDeps.billing,
      mailer: fullDeps.mailer,
      redis: fullDeps.redis,
    })
  })
  return worker
}
