import { Queue } from 'bullmq'
import type Redis from 'ioredis'

export const gradeQueueName = 'grade' as const
export const reportQueueName = 'report' as const
export const pdfQueueName = 'pdf' as const

export interface GradeJob {
  gradeId: string
  tier: 'free' | 'paid'
}
export interface ReportJob {
  gradeId: string
}
export interface PdfJob {
  gradeId: string
  token: string
}

let gradeQueue: Queue<GradeJob> | undefined
let reportQueue: Queue<ReportJob> | undefined
let pdfQueue: Queue<PdfJob> | undefined

export function getGradeQueue(connection: Redis): Queue<GradeJob> {
  gradeQueue ??= new Queue<GradeJob>(gradeQueueName, { connection })
  return gradeQueue
}
export function getReportQueue(connection: Redis): Queue<ReportJob> {
  reportQueue ??= new Queue<ReportJob>(reportQueueName, { connection })
  return reportQueue
}
export function getPdfQueue(connection: Redis): Queue<PdfJob> {
  pdfQueue ??= new Queue<PdfJob>(pdfQueueName, { connection })
  return pdfQueue
}

export async function enqueueGrade(job: GradeJob, connection: Redis): Promise<void> {
  await getGradeQueue(connection).add('run-grade', job, {
    removeOnComplete: { age: 3600 }, // 1h
    removeOnFail: { age: 24 * 3600 }, // 1d
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  })
}

export async function enqueueReport(job: ReportJob, connection: Redis): Promise<void> {
  await getReportQueue(connection).add('generate-report', job, { attempts: 3 })
}

import { QueueEvents } from 'bullmq'

let pdfQueueEvents: QueueEvents | undefined
function getPdfQueueEvents(connection: Redis): QueueEvents {
  pdfQueueEvents ??= new QueueEvents(pdfQueueName, { connection })
  return pdfQueueEvents
}

export async function enqueuePdf(job: PdfJob, connection: Redis): Promise<Buffer> {
  const queued = await getPdfQueue(connection).add('render-pdf', job, { attempts: 2 })
  const result = await queued.waitUntilFinished(getPdfQueueEvents(connection), 30_000)
  if (!(result instanceof Buffer)) throw new Error('PDF job did not return a Buffer')
  return result
}
