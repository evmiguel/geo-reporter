import { Worker } from 'bullmq'
import type Redis from 'ioredis'
import { enqueuePdf, reportQueueName, type PdfJob, type ReportJob } from '../../queues.ts'
import { generateReport, type GenerateReportJob } from './generate-report.ts'
import { runRecommender } from './recommender.ts'
import type { GenerateReportDeps } from './deps.ts'

type JobDataInput = Pick<GenerateReportJob, 'gradeId' | 'sessionId'>

export function registerGenerateReportWorker(
  deps: Omit<GenerateReportDeps, 'recommenderFn' | 'enqueuePdfFn'>,
  connection: Redis,
): Worker<ReportJob> {
  const enqueuePdfFn = (job: PdfJob): Promise<void> => enqueuePdf(job, connection)
  const fullDeps: GenerateReportDeps = { ...deps, recommenderFn: runRecommender, enqueuePdfFn }
  return new Worker<ReportJob>(
    reportQueueName,
    async (job) => {
      const data = job.data as JobDataInput
      if (!data.sessionId) throw new Error('generate-report: missing sessionId on job data')
      await generateReport(fullDeps, { gradeId: data.gradeId, sessionId: data.sessionId })
    },
    { connection, concurrency: 1 },
  )
}
