import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { createRedis } from '../../src/queue/redis.ts'
import { publishGradeEvent, subscribeToGrade, type GradeEvent } from '../../src/queue/events.ts'

let container: StartedTestContainer
let redisUrl: string

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('publishGradeEvent + subscribeToGrade', () => {
  it('round-trips a running event', async () => {
    const publisher = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const gradeId = 'g-1'

    const received: Promise<GradeEvent[]> = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, gradeId)) {
        out.push(ev)
        if (ev.type === 'done' || ev.type === 'failed') break
      }
      return out
    })()

    await new Promise((r) => setTimeout(r, 50))
    await publishGradeEvent(publisher, gradeId, { type: 'running' })
    await publishGradeEvent(publisher, gradeId, { type: 'done', overall: 80, letter: 'B', scores: { discoverability: 80, recognition: null, accuracy: null, coverage: null, citation: null, seo: null } })

    const events = await received
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('running')
    expect(events[1]?.type).toBe('done')

    await publisher.quit()
    await subscriber.quit()
  })

  it('terminates the iterator on done', async () => {
    const publisher = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const gradeId = 'g-2'

    const pending = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, gradeId)) {
        out.push(ev)
      }
      return out
    })()

    await new Promise((r) => setTimeout(r, 50))
    await publishGradeEvent(publisher, gradeId, { type: 'scraped', rendered: false, textLength: 1200 })
    await publishGradeEvent(publisher, gradeId, { type: 'done', overall: 70, letter: 'C', scores: { discoverability: 70, recognition: null, accuracy: null, coverage: null, citation: null, seo: null } })

    const events = await pending
    expect(events).toHaveLength(2)

    await publisher.quit()
    await subscriber.quit()
  })

  it('terminates the iterator on failed', async () => {
    const publisher = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const gradeId = 'g-3'

    const pending = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, gradeId)) out.push(ev)
      return out
    })()

    await new Promise((r) => setTimeout(r, 50))
    await publishGradeEvent(publisher, gradeId, { type: 'failed', error: 'boom' })
    const events = await pending
    expect(events).toEqual([{ type: 'failed', error: 'boom' }])

    await publisher.quit()
    await subscriber.quit()
  })

  it('terminates the iterator when AbortSignal fires', async () => {
    const publisher = createRedis(redisUrl)
    const subscriber = createRedis(redisUrl)
    const gradeId = 'g-4'
    const ctrl = new AbortController()

    const pending = (async () => {
      const out: GradeEvent[] = []
      for await (const ev of subscribeToGrade(subscriber, gradeId, ctrl.signal)) out.push(ev)
      return out
    })()

    await new Promise((r) => setTimeout(r, 50))
    await publishGradeEvent(publisher, gradeId, { type: 'running' })
    await new Promise((r) => setTimeout(r, 50))
    ctrl.abort()
    const events = await pending
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('running')

    await publisher.quit()
    await subscriber.quit()
  })

  it('delivers events to multiple subscribers on the same gradeId', async () => {
    const publisher = createRedis(redisUrl)
    const sub1 = createRedis(redisUrl)
    const sub2 = createRedis(redisUrl)
    const gradeId = 'g-5'

    const results = [
      (async () => { const out: GradeEvent[] = []; for await (const ev of subscribeToGrade(sub1, gradeId)) { out.push(ev); if (ev.type === 'done') break } return out })(),
      (async () => { const out: GradeEvent[] = []; for await (const ev of subscribeToGrade(sub2, gradeId)) { out.push(ev); if (ev.type === 'done') break } return out })(),
    ]

    await new Promise((r) => setTimeout(r, 100))
    await publishGradeEvent(publisher, gradeId, { type: 'scraped', rendered: true, textLength: 5000 })
    await publishGradeEvent(publisher, gradeId, { type: 'done', overall: 90, letter: 'A-', scores: { discoverability: null, recognition: null, accuracy: null, coverage: null, citation: null, seo: 90 } })

    const [a, b] = await Promise.all(results)
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)

    await publisher.quit()
    await sub1.quit()
    await sub2.quit()
  })
})
