import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.getReportById', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('returns null for unknown id', async () => {
    const r = await store.getReportById(randomUUID())
    expect(r).toBeNull()
  })

  it('returns null when grade is not done', async () => {
    const grade = await store.createGrade({
      url: 'https://s.test', domain: 's.test', tier: 'free', cookie: null, userId: null, status: 'running',
    })
    const report = await store.createReport({ gradeId: grade.id, token: 'abc' })
    const r = await store.getReportById(report.id)
    expect(r).toBeNull()
  })

  it('returns null when tier is not paid', async () => {
    const grade = await store.createGrade({
      url: 'https://s2.test', domain: 's2.test', tier: 'free', cookie: null, userId: null, status: 'done',
    })
    const report = await store.createReport({ gradeId: grade.id, token: 'xyz' })
    const r = await store.getReportById(report.id)
    expect(r).toBeNull()
  })

  it('returns joined record for paid report', async () => {
    const grade = await store.createGrade({
      url: 'https://s3.test', domain: 's3.test', tier: 'paid', cookie: null, userId: null, status: 'done',
      overall: 80, letter: 'B',
    })
    await store.createScrape({ gradeId: grade.id, rendered: false, html: '<html></html>', text: 'hi', structured: {} as never })
    await store.createProbe({ gradeId: grade.id, category: 'discoverability', provider: 'claude', prompt: 'q', response: 'a', score: 80, metadata: { model: 'claude-sonnet-4-6', label: 'self-gen' } })
    await store.createRecommendations([{ gradeId: grade.id, rank: 1, title: 't', category: 'accuracy', impact: 5, effort: 2, rationale: 'r', how: 'h' }])
    const report = await store.createReport({ gradeId: grade.id, token: 'tok' })

    const r = await store.getReportById(report.id)
    expect(r).not.toBeNull()
    expect(r!.report.id).toBe(report.id)
    expect(r!.grade.id).toBe(grade.id)
    expect(r!.scrape?.text).toBe('hi')
    expect(r!.probes.length).toBe(1)
    expect(r!.recommendations.length).toBe(1)
    expect(r!.recommendations[0]!.rank).toBe(1)
  })
})
