import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.listGradesByUser', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('returns grades for the user ordered by createdAt desc', async () => {
    const user = await store.upsertUser('hist@example.com')
    const other = await store.upsertUser('other@example.com')
    await store.upsertCookie('c-a', user.id)
    await store.upsertCookie('c-b', other.id)

    const g1 = await store.createGrade({
      url: 'https://a', domain: 'a', tier: 'free', cookie: 'c-a', userId: user.id, status: 'done',
    })
    const g2 = await store.createGrade({
      url: 'https://b', domain: 'b', tier: 'paid', cookie: 'c-a', userId: user.id, status: 'done',
    })
    // owned by other user — must be excluded
    await store.createGrade({
      url: 'https://c', domain: 'c', tier: 'free', cookie: 'c-b', userId: other.id, status: 'done',
    })

    const list = await store.listGradesByUser(user.id, 50)
    expect(list.map((g) => g.id)).toEqual([g2.id, g1.id])
  })

  it('respects limit', async () => {
    const user = await store.upsertUser('limit@example.com')
    await store.upsertCookie('c-limit', user.id)
    for (let i = 0; i < 5; i++) {
      await store.createGrade({
        url: `https://${i}`, domain: String(i), tier: 'free',
        cookie: 'c-limit', userId: user.id, status: 'done',
      })
    }
    const list = await store.listGradesByUser(user.id, 3)
    expect(list).toHaveLength(3)
  })

  it('returns empty array when user has no grades', async () => {
    const user = await store.upsertUser('empty@example.com')
    const list = await store.listGradesByUser(user.id, 50)
    expect(list).toEqual([])
  })
})
