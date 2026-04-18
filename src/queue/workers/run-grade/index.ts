import { Worker } from 'bullmq'
import type Redis from 'ioredis'
import { gradeQueueName, type GradeJob } from '../../queues.ts'
import { runGrade } from './run-grade.ts'
import type { RunGradeDeps } from './deps.ts'

export function registerRunGradeWorker(deps: RunGradeDeps, connection: Redis): Worker<GradeJob> {
  return new Worker<GradeJob>(
    gradeQueueName,
    (job) => runGrade(job, deps),
    { connection, concurrency: 2 },
  )
}
