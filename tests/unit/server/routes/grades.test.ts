import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../../../src/server/app.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'
import type { ServerDeps } from '../../../../src/server/deps.ts'
import type Redis from 'ioredis'
import type { Queue } from 'bullmq'

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
    mailer: new FakeMailer(),
    billing: null,
    reportQueue: {} as Queue,
    pingDb: async () => true,
    pingRedis: async () => true,
    env: {
      NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'test-key-exactly-32-chars-long-aa',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      STRIPE_PRICE_ID: null,
      STRIPE_WEBHOOK_SECRET: null,
      STRIPE_CREDITS_PRICE_ID: null,
    },
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

  it('stores userId=null for an anonymous cookie', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const res = await app.request('/grades', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://acme.com' }),
    })
    const { gradeId } = (await res.json()) as { gradeId: string }
    const store = deps.store as ReturnType<typeof makeFakeStore>
    expect(store.gradesMap.get(gradeId)?.userId).toBeNull()
  })

  it('stores the caller userId when the cookie is bound to a verified user', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const user = await store.upsertUser('verified@example.com')

    // Issue a cookie first to get the middleware-signed value back.
    const app = buildApp(deps)
    const bootstrap = await app.request('/auth/me')
    const setCookie = bootstrap.headers.get('set-cookie') ?? ''
    const cookieValue = setCookie.split('ggcookie=')[1]?.split(';')[0]
    expect(cookieValue).toBeTruthy()
    const uuid = cookieValue!.split('.')[0]!
    await store.upsertCookie(uuid, user.id)

    const res = await app.request('/grades', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `ggcookie=${cookieValue}`,
      },
      body: JSON.stringify({ url: 'https://acme.com' }),
    })
    expect(res.status).toBe(202)
    const { gradeId } = (await res.json()) as { gradeId: string }
    expect(store.gradesMap.get(gradeId)?.userId).toBe(user.id)
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

/**
 * Helper: issue a fresh signed cookie by hitting any grade-scope route.
 * Returns the raw signed cookie value (uuid.hmac).
 */
async function issueCookie(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await app.request('/grades/00000000-0000-0000-0000-000000000000')
  const setCookie = res.headers.get('set-cookie') ?? ''
  const raw = setCookie.split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('GET /grades/:id ownership (cookie-or-userId)', () => {
  it('allows a verified user with a DIFFERENT cookie when userId matches', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const app = buildApp(deps)
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('cross@example.com')
    await store.upsertCookie(uuid, user.id)
    // Grade was created under a different cookie, but is owned by the same user.
    await store.upsertCookie('old-cookie', user.id)
    const grade = await store.createGrade({
      url: 'https://x.example', domain: 'x.example', tier: 'free',
      cookie: 'old-cookie', userId: user.id, status: 'done',
    })
    const res = await app.request(`/grades/${grade.id}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    })
    expect(res.status).toBe(200)
  })

  it('still allows when cookie matches and userId differs/null', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const app = buildApp(deps)
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const grade = await store.createGrade({
      url: 'https://x.example', domain: 'x.example', tier: 'free',
      cookie: uuid, userId: null, status: 'done',
    })
    const res = await app.request(`/grades/${grade.id}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    })
    expect(res.status).toBe(200)
  })

  it('denies when neither cookie nor userId matches', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const app = buildApp(deps)
    const cookie = await issueCookie(app)
    const grade = await store.createGrade({
      url: 'https://x.example', domain: 'x.example', tier: 'free',
      cookie: 'unrelated-cookie', userId: 'unrelated-user', status: 'done',
    })
    const res = await app.request(`/grades/${grade.id}`, {
      headers: { cookie: `ggcookie=${cookie}` },
    })
    expect(res.status).toBe(403)
  })
})
