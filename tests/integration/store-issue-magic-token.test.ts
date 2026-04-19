import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
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

beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE magic_tokens, cookies, users CASCADE`)
})

describe('PostgresStore.issueMagicToken', () => {
  it('issues a token and persists a row', async () => {
    await store.upsertCookie('cookie-imt-1')
    const { rawToken, expiresAt } = await store.issueMagicToken('user@example.com', 'cookie-imt-1')
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000)
    const rows = await testDb.db.execute(sql`SELECT * FROM magic_tokens WHERE email = 'user@example.com'`)
    expect(rows).toHaveLength(1)
  })

  it('invalidates prior unconsumed tokens for same email', async () => {
    await store.upsertCookie('cookie-imt-2')
    await store.issueMagicToken('user@example.com', 'cookie-imt-2')
    await store.issueMagicToken('user@example.com', 'cookie-imt-2')
    const rows = await testDb.db.execute(
      sql`SELECT consumed_at FROM magic_tokens WHERE email = 'user@example.com' ORDER BY created_at`,
    )
    expect(rows).toHaveLength(2)
    expect((rows[0] as { consumed_at: Date | null }).consumed_at).not.toBeNull()
    expect((rows[1] as { consumed_at: Date | null }).consumed_at).toBeNull()
  })

  it('does not invalidate tokens for other emails', async () => {
    await store.upsertCookie('cookie-imt-3')
    await store.issueMagicToken('a@example.com', 'cookie-imt-3')
    await store.issueMagicToken('b@example.com', 'cookie-imt-3')
    const rows = await testDb.db.execute(
      sql`SELECT consumed_at FROM magic_tokens WHERE email = 'a@example.com'`,
    )
    expect(rows).toHaveLength(1)
    expect((rows[0] as { consumed_at: Date | null }).consumed_at).toBeNull()
  })
})
