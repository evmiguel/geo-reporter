import { describe, expect, it } from 'vitest'
import { buildApp } from '../../../src/server/app.ts'
import type { ServerDeps } from '../../../src/server/deps.ts'
import { makeFakeStore } from '../_helpers/fake-store.ts'
import type Redis from 'ioredis'

function makeStubRedis(): Redis {
  return {} as unknown as Redis
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    store: makeFakeStore(),
    redis: makeStubRedis(),
    redisFactory: () => makeStubRedis(),
    pingDb: async () => true,
    pingRedis: async () => true,
    env: { NODE_ENV: 'test' },
    ...overrides,
  }
}

describe('/healthz (unit)', () => {
  it('returns ok when both deps are healthy', async () => {
    const app = buildApp(makeDeps())
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: true, redis: true })
  })

  it('returns 503 when db fails', async () => {
    const app = buildApp(makeDeps({ pingDb: async () => false }))
    const res = await app.request('/healthz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; db: boolean; redis: boolean }
    expect(body.ok).toBe(false)
    expect(body.db).toBe(false)
  })

  it('returns 503 when redis throws', async () => {
    const app = buildApp(makeDeps({ pingRedis: async () => { throw new Error('boom') } }))
    const res = await app.request('/healthz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; db: boolean; redis: boolean }
    expect(body.redis).toBe(false)
  })
})
