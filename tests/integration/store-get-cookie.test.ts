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

describe('PostgresStore.getCookie', () => {
  it('returns null for a cookie that does not exist', async () => {
    expect(await store.getCookie('does-not-exist')).toBeNull()
  })

  it('returns the row after upsertCookie', async () => {
    await store.upsertCookie('cookie-gc-1')
    const row = await store.getCookie('cookie-gc-1')
    expect(row).not.toBeNull()
    expect(row?.cookie).toBe('cookie-gc-1')
    expect(row?.userId).toBeNull()
  })

  it('reflects userId after binding', async () => {
    const user = await store.upsertUser('gc-user@example.com')
    await store.upsertCookie('cookie-gc-2', user.id)
    const row = await store.getCookie('cookie-gc-2')
    expect(row?.userId).toBe(user.id)
  })
})
