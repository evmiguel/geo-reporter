import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Worker } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { enqueueGrade, gradeQueueName } from '../../src/queue/queues.ts'

let container: StartedTestContainer
let redisUrl: string

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('enqueueGrade', () => {
  it('enqueues a job that a worker picks up', async () => {
    const producerRedis = createRedis(redisUrl)
    const consumerRedis = createRedis(redisUrl)

    const received: string[] = []
    const worker = new Worker(
      gradeQueueName,
      async (job) => {
        received.push(job.data.gradeId)
      },
      { connection: consumerRedis },
    )

    await enqueueGrade({ gradeId: 'grade-1', tier: 'free' }, producerRedis)

    await new Promise<void>((resolve) => {
      worker.on('completed', () => resolve())
    })

    expect(received).toEqual(['grade-1'])

    await worker.close()
    await producerRedis.quit()
    await consumerRedis.quit()
  })
})
