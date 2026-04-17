import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let ctx: TestDb
let store: PostgresStore

beforeAll(async () => {
  ctx = await startTestDb()
  store = new PostgresStore(ctx.db)
}, 60_000)

afterAll(async () => {
  await ctx.stop()
})

describe('PostgresStore', () => {
  it('creates and fetches a grade', async () => {
    const created = await store.createGrade({
      url: 'https://example.com',
      domain: 'example.com',
      tier: 'free',
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i)
    const fetched = await store.getGrade(created.id)
    expect(fetched?.url).toBe('https://example.com')
    expect(fetched?.status).toBe('queued')
  })

  it('updateGrade patches status and scores', async () => {
    const g = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.updateGrade(g.id, { status: 'done', overall: 72, letter: 'B-', scores: { recognition: 80 } })
    const after = await store.getGrade(g.id)
    expect(after?.status).toBe('done')
    expect(after?.overall).toBe(72)
  })

  it('createProbe + listProbes round-trips', async () => {
    const g = await store.createGrade({ url: 'https://y.com', domain: 'y.com', tier: 'free' })
    await store.createProbe({
      gradeId: g.id,
      category: 'recognition',
      provider: 'claude',
      prompt: 'p',
      response: 'r',
      score: 55,
    })
    const probes = await store.listProbes(g.id)
    expect(probes).toHaveLength(1)
    expect(probes[0]?.category).toBe('recognition')
  })

  it('createScrape + getScrape round-trips', async () => {
    const g = await store.createGrade({ url: 'https://z.com', domain: 'z.com', tier: 'free' })
    await store.createScrape({
      gradeId: g.id,
      rendered: false,
      html: '<html>',
      text: 'hi',
      structured: { og: {} },
    })
    const s = await store.getScrape(g.id)
    expect(s?.text).toBe('hi')
  })

  it('upsertUser is idempotent', async () => {
    const a = await store.upsertUser('a@b.com')
    const b = await store.upsertUser('a@b.com')
    expect(a.id).toBe(b.id)
  })

  it('createReport + getReport round-trips', async () => {
    const g = await store.createGrade({ url: 'https://q.com', domain: 'q.com', tier: 'paid' })
    await store.createReport({ gradeId: g.id, token: 'abc' })
    const r = await store.getReport(g.id)
    expect(r?.token).toBe('abc')
  })
})
