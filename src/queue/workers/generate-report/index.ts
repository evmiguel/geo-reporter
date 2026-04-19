import { Worker } from 'bullmq'
import type Redis from 'ioredis'
import { reportQueueName, type ReportJob } from '../../queues.ts'
import { generateReport, type GenerateReportJob } from './generate-report.ts'
import { runRecommender } from './recommender.ts'
import type { GenerateReportDeps } from './deps.ts'

type JobDataInput = Pick<GenerateReportJob, 'gradeId' | 'sessionId'>

export function registerGenerateReportWorker(
  deps: Omit<GenerateReportDeps, 'recommenderFn'>,
  connection: Redis,
): Worker<ReportJob> {
  const fullDeps: GenerateReportDeps = { ...deps, recommenderFn: runRecommender }
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
