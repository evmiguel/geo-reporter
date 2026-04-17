import { Worker } from 'bullmq'
import type Redis from 'ioredis'

export const healthQueueName = 'health' as const

export function registerHealthWorker(connection: Redis): Worker {
  return new Worker(
    healthQueueName,
    async () => ({ ok: true, at: Date.now() }),
    { connection },
  )
}
