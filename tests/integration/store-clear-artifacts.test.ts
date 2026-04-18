import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => {
  testDb = await startTestDb()
  store = new PostgresStore(testDb.db)
}, 60_000)

afterAll(async () => {
  await testDb.stop()
})

describe('PostgresStore.clearGradeArtifacts', () => {
  it('deletes scrape and probes rows for the given gradeId', async () => {
    const cookie = await store.upsertCookie('cookie-clear-1')
    const grade = await store.createGrade({
      url: 'https://example.com', domain: 'example.com', tier: 'free',
      cookie: cookie.cookie, status: 'running',
    })
    await store.createScrape({
      gradeId: grade.id, rendered: false, html: '<html/>', text: 'x',
      structured: { jsonld: [], og: {}, meta: {}, headings: { h1: [], h2: [] }, robots: null, sitemap: { present: false, url: '' }, llmsTxt: { present: false, url: '' } },
    })
    await store.createProbe({ gradeId: grade.id, category: 'seo', provider: null, prompt: 'title', response: 'pass', score: 100, metadata: {} })
    await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'claude', prompt: 'q', response: 'r', score: 70, metadata: {} })

    await store.clearGradeArtifacts(grade.id)

    const scrape = await store.getScrape(grade.id)
    const probes = await store.listProbes(grade.id)
    expect(scrape).toBeNull()
    expect(probes).toHaveLength(0)
  })

  it('does not touch other grades artifacts', async () => {
    const cookie = await store.upsertCookie('cookie-clear-2')
    const a = await store.createGrade({ url: 'https://a.com', domain: 'a.com', tier: 'free', cookie: cookie.cookie, status: 'running' })
    const b = await store.createGrade({ url: 'https://b.com', domain: 'b.com', tier: 'free', cookie: cookie.cookie, status: 'running' })
    await store.createProbe({ gradeId: a.id, category: 'seo', provider: null, prompt: 'x', response: 'y', score: 100, metadata: {} })
    await store.createProbe({ gradeId: b.id, category: 'seo', provider: null, prompt: 'x', response: 'y', score: 100, metadata: {} })

    await store.clearGradeArtifacts(a.id)

    expect(await store.listProbes(a.id)).toHaveLength(0)
    expect(await store.listProbes(b.id)).toHaveLength(1)
  })

  it('is a no-op when the grade has no artifacts', async () => {
    const cookie = await store.upsertCookie('cookie-clear-3')
    const grade = await store.createGrade({ url: 'https://c.com', domain: 'c.com', tier: 'free', cookie: cookie.cookie, status: 'queued' })
    await expect(store.clearGradeArtifacts(grade.id)).resolves.toBeUndefined()
  })
})
