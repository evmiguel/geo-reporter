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
    async publish() { return 1 },
    async subscribe() { return 0 },
    async unsubscribe() { return 0 },
    on() { return stub },
    once() { return stub },
    removeListener() { return stub },
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

describe('GET /grades (list my grades)', () => {
  it('401 when cookie is not bound to a user', async () => {
    const deps = makeDeps()
    const app = buildApp(deps)
    const cookie = await issueCookie(app)

    const res = await app.request('/grades', {
      headers: { cookie: `ggcookie=${cookie}` },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('must_verify_email')
  })

  it('200 with grades ordered newest-first when verified', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const app = buildApp(deps)
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('list@example.com')
    await store.upsertCookie(uuid, user.id)

    const older = await store.createGrade({
      url: 'https://older.example', domain: 'older.example', tier: 'free',
      cookie: uuid, userId: user.id, status: 'done',
    })
    const newer = await store.createGrade({
      url: 'https://newer.example', domain: 'newer.example', tier: 'free',
      cookie: uuid, userId: user.id, status: 'done',
    })
    // Force deterministic ordering by rewriting createdAt.
    store.gradesMap.set(older.id, { ...store.gradesMap.get(older.id)!, createdAt: new Date('2026-01-01T00:00:00Z') })
    store.gradesMap.set(newer.id, { ...store.gradesMap.get(newer.id)!, createdAt: new Date('2026-02-01T00:00:00Z') })

    const res = await app.request('/grades', {
      headers: { cookie: `ggcookie=${cookie}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      grades: Array<{ id: string; url: string; domain: string; createdAt: string }>
    }
    expect(body.grades).toHaveLength(2)
    expect(body.grades[0]?.id).toBe(newer.id)
    expect(body.grades[1]?.id).toBe(older.id)
    expect(body.grades[0]?.url).toBe('https://newer.example')
    expect(body.grades[0]?.createdAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('does NOT leak other users grades', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const app = buildApp(deps)
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const userA = await store.upsertUser('a@example.com')
    const userB = await store.upsertUser('b@example.com')
    await store.upsertCookie(uuid, userA.id)

    const aGrade = await store.createGrade({
      url: 'https://a.example', domain: 'a.example', tier: 'free',
      cookie: uuid, userId: userA.id, status: 'done',
    })
    await store.createGrade({
      url: 'https://b.example', domain: 'b.example', tier: 'free',
      cookie: 'b-cookie', userId: userB.id, status: 'done',
    })

    const res = await app.request('/grades', {
      headers: { cookie: `ggcookie=${cookie}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { grades: Array<{ id: string; url: string }> }
    expect(body.grades).toHaveLength(1)
    expect(body.grades[0]?.id).toBe(aGrade.id)
    expect(body.grades[0]?.url).toBe('https://a.example')
  })

  it('returns empty array when user has no grades', async () => {
    const deps = makeDeps()
    const store = deps.store as ReturnType<typeof makeFakeStore>
    const app = buildApp(deps)
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('empty@example.com')
    await store.upsertCookie(uuid, user.id)

    const res = await app.request('/grades', {
      headers: { cookie: `ggcookie=${cookie}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { grades: unknown[] }
    expect(body.grades).toEqual([])
  })
})
