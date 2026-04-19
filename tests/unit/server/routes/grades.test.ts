import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../../../src/server/app.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import type { ServerDeps } from '../../../../src/server/deps.ts'
import type Redis from 'ioredis'

vi.mock('../../../../src/queue/queues.ts', () => ({
  enqueueGrade: vi.fn(() => Promise.resolve()),
  gradeQueueName: 'grade',
  reportQueueName: 'report',
  pdfQueueName: 'pdf',
  getGradeQueue: vi.fn(),
  getReportQueue: vi.fn(),
  getPdfQueue: vi.fn(),
  enqueueReport: vi.fn(() => Promise.resolve()),
  enqueuePdf: vi.fn(),
}))

function makeStubRedis() {
  const stub = {
    // Pub/sub
    async publish() { return 1 },
    async subscribe() { return 0 },
    async unsubscribe() { return 0 },
    on() { return stub },
    once() { return stub },
    removeListener() { return stub },
    // Rate limit (sorted sets)
    async zadd() { return 1 },
    async zcard() { return 0 },
    async zremrangebyscore() { return 0 },
    async zrange() { return [] as string[] },
    async expire() { return 1 },
    // BullMQ support
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
    // For Drizzle pool compatibility
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

describe('POST /grades', () => {
  it('returns 202 with gradeId on valid body, creates grade row', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const res = await app.request('/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://acme.com/page' }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { gradeId: string }
    expect(body.gradeId).toMatch(/^[0-9a-f-]{36}$/)
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const grade = store.gradesMap.get(body.gradeId)
    expect(grade).toBeDefined()
    expect(grade?.url).toBe('https://acme.com/page')
    expect(grade?.domain).toBe('acme.com')
    expect(grade?.tier).toBe('free')
    expect(grade?.status).toBe('queued')
    expect(grade?.cookie).toBeTruthy()
  })

  it('strips leading www. from domain', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.acme.com/' }),
    })
    const body = (await res.json()) as { gradeId: string }
    const store = deps.store as ReturnType<typeof makeFakeStore>
    expect(store.gradesMap.get(body.gradeId)?.domain).toBe('acme.com')
  })

  it('returns 400 for missing body', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-URL string', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'not a url' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-http scheme', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://example.com/' }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts http:// URLs', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://acme.com' }),
    })
    expect(res.status).toBe(202)
  })
})

describe('GET /grades/:id', () => {
  it('returns the grade JSON for the owning cookie', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const created = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://acme.com' }),
    })
    const { gradeId } = (await created.json()) as { gradeId: string }
    const setCookie = created.headers.get('set-cookie')
    const cookieHeader = setCookie?.split(';')[0] ?? ''

    const res = await app.request(`/grades/${gradeId}`, { headers: { cookie: cookieHeader } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; url: string; tier: string; status: string }
    expect(body.id).toBe(gradeId)
    expect(body.url).toBe('https://acme.com')
    expect(body.tier).toBe('free')
    expect(body.status).toBe('queued')
  })

  it('returns 403 when cookie does not own the grade', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const created = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://acme.com' }),
    })
    const { gradeId } = (await created.json()) as { gradeId: string }
    const res = await app.request(`/grades/${gradeId}`, {
      headers: { cookie: 'ggcookie=11111111-2222-3333-4444-555555555555' },
    })
    expect(res.status).toBe(403)
  })

  it('returns 404 for unknown grade', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  it('returns 400 for a malformed id', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/grades/not-a-uuid')
    expect(res.status).toBe(400)
  })
})
