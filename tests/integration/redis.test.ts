import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { createRedis } from '../../src/queue/redis.ts'
import type Redis from 'ioredis'

let container: StartedTestContainer
let redis: Redis

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
  redis = createRedis(url)
}, 60_000)

afterAll(async () => {
  await redis.quit()
  await container.stop()
})

describe('createRedis', () => {
  it('connects and PING returns PONG', async () => {
    const reply = await redis.ping()
    expect(reply).toBe('PONG')
  })

  it('can set and get a key', async () => {
    await redis.set('foo', 'bar')
    expect(await redis.get('foo')).toBe('bar')
  })
})
