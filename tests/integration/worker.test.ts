import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Queue, QueueEvents } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { registerHealthWorker, healthQueueName } from '../../src/queue/workers/health.ts'

let container: StartedTestContainer
let redisUrl: string

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('health worker', () => {
  it('acks a health-ping job', async () => {
    const connection = createRedis(redisUrl)
    const worker = registerHealthWorker(connection)
    const queue = new Queue(healthQueueName, { connection })
    const events = new QueueEvents(healthQueueName, { connection: createRedis(redisUrl) })

    const job = await queue.add('ping', {})
    const result = await job.waitUntilFinished(events, 10_000)
    expect(result.ok).toBe(true)

    await worker.close()
    await queue.close()
    await events.close()
    await connection.quit()
  })
})
