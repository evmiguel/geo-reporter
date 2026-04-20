import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.hasTerminalProviderFailures', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  async function freshGrade(): Promise<string> {
    const cookie = `c-${Math.random()}`
    await store.upsertCookie(cookie)
    const g = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie, userId: null, status: 'running',
    })
    return g.id
  }

  it('returns false when all Claude/OpenAI probes have a score', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'claude', prompt: 'p', response: 'r', score: 50, metadata: {} })
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'openai', prompt: 'p', response: 'r', score: 50, metadata: {} })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(false)
  })

  it('returns true when Claude has a null score + error metadata', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'claude', prompt: '', response: '', score: null, metadata: { error: 'Anthropic 500' } })
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'openai', prompt: 'p', response: 'r', score: 50, metadata: {} })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(true)
  })

  it('returns true when OpenAI has a null score + error metadata', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'claude', prompt: 'p', response: 'r', score: 50, metadata: {} })
    await store.createProbe({ gradeId, category: 'discoverability', provider: 'openai', prompt: '', response: '', score: null, metadata: { error: 'OpenAI 429' } })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(true)
  })

  it('returns false when null score has no error metadata (intentional skip)', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'accuracy', provider: 'claude', prompt: '', response: '', score: null, metadata: { role: 'skipped', reason: 'no ground truth' } })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(false)
  })

  it('ignores Gemini + Perplexity failures (only Claude + OpenAI gate)', async () => {
    const gradeId = await freshGrade()
    await store.createProbe({ gradeId, category: 'recognition', provider: 'gemini', prompt: '', response: '', score: null, metadata: { error: 'Gemini down' } })
    await store.createProbe({ gradeId, category: 'recognition', provider: 'perplexity', prompt: '', response: '', score: null, metadata: { error: 'Perplexity down' } })
    expect(await store.hasTerminalProviderFailures(gradeId)).toBe(false)
  })
})
