import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../../../src/server/app.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import type { ServerDeps } from '../../../../src/server/deps.ts'
import type Redis from 'ioredis'

vi.mock('../../../../src/queue/events.ts', () => ({
  subscribeToGrade: vi.fn(async function* () {
    // Default: no events, should be overridable
    yield { type: 'done', overall: 0, letter: 'F', scores: {} }
  }),
  publishGradeEvent: vi.fn(() => Promise.resolve()),
  channelFor: (id: string) => `grade:${id}`,
}))

function makeStubRedis() {
  const stub = {
    async publish() { return 1 },
    async zadd() { return 1 },
    async zcard() { return 0 },
    async zremrangebyscore() { return 0 },
    async zrange() { return [] as string[] },
    async expire() { return 1 },
    async get() { return null },
    async set() { return 'OK' },
    async del() { return 0 },
    async exists() { return 0 },
    async lpush() { return 1 },
    async rpop() { return null },
    async lrange() { return [] as string[] },
    async llen() { return 0 },
    async hget() { return null },
    async hset() { return 0 },
    async hgetall() { return {} },
    async hdel() { return 0 },
    async hincrby() { return 0 },
    async ping() { return 'PONG' },
    async quit() { return undefined },
    async subscribe() { return 0 },
    async unsubscribe() { return 0 },
    on() { return stub },
    once() { return stub },
    removeListener() { return stub },
    ready: true,
  }
  return stub as unknown as Redis
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    store: makeFakeStore(),
    redis: makeStubRedis(),
    redisFactory: () => makeStubRedis(),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: { NODE_ENV: 'test', COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa' },
    ...overrides,
  }
}

describe('GET /grades/:id/events (unit — early exit paths)', () => {
  it('returns 400 for malformed id', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades/not-a-uuid/events')
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown grade', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades/00000000-0000-0000-0000-000000000000/events')
    expect(res.status).toBe(404)
  })

  it('returns 403 when cookie does not own the grade', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    await store.upsertCookie('owning-cookie')
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free',
      cookie: 'owning-cookie', userId: null, status: 'queued',
    })
    const app = buildApp(deps)
    const res = await app.request(`/grades/${grade.id}/events`, {
      headers: { cookie: 'ggcookie=11111111-2222-3333-4444-555555555555' },
    })
    expect(res.status).toBe(403)
  })

  it('emits one synthesized done event for a done grade and closes the stream', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const cookieValue = '22222222-3333-4444-5555-666666666666'
    await store.upsertCookie(cookieValue)
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free',
      cookie: cookieValue, userId: null, status: 'done',
      overall: 85, letter: 'B', scores: { discoverability: 90, recognition: 80, accuracy: 75, coverage: 85, citation: 100, seo: 80 },
    })
    const app = buildApp(deps)
    const res = await app.request(`/grades/${grade.id}/events`, {
      headers: { cookie: `ggcookie=${cookieValue}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await res.text()
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
    expect(dataLines).toHaveLength(1)
    expect(dataLines[0]).toMatchObject({ type: 'done', overall: 85, letter: 'B' })
  })

  it('emits one synthesized failed event for a failed grade', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const cookieValue = '33333333-4444-5555-6666-777777777777'
    await store.upsertCookie(cookieValue)
    const grade = await store.createGrade({
      url: 'https://acme.com', domain: 'acme.com', tier: 'free',
      cookie: cookieValue, userId: null, status: 'failed',
    })
    const app = buildApp(deps)
    const res = await app.request(`/grades/${grade.id}/events`, {
      headers: { cookie: `ggcookie=${cookieValue}` },
    })
    const text = await res.text()
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
    expect(dataLines).toHaveLength(1)
    expect(dataLines[0]).toMatchObject({ type: 'failed' })
  })
})
