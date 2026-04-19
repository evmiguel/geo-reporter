import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => { testDb = await startTestDb(); store = new PostgresStore(testDb.db) }, 60_000)
afterAll(async () => { await testDb.stop() })
beforeEach(async () => { await testDb.db.execute(sql`TRUNCATE magic_tokens, cookies, users CASCADE`) })

const hashOf = (raw: string): string => createHash('sha256').update(raw).digest('hex')

describe('PostgresStore.unbindCookie', () => {
  it('nulls user_id but keeps the cookie row', async () => {
    await store.upsertCookie('c-u-1')
    const { rawToken } = await store.issueMagicToken('u@example.com', 'c-u-1')
    await store.consumeMagicToken(hashOf(rawToken), 'c-u-1')
    const before = await store.getCookie('c-u-1')
    expect(before!.userId).not.toBeNull()
    await store.unbindCookie('c-u-1')
    const after = await store.getCookie('c-u-1')
    expect(after).not.toBeNull()
    expect(after!.userId).toBeNull()
  })

  it('no-op for unknown cookie', async () => {
    await expect(store.unbindCookie('nonexistent')).resolves.toBeUndefined()
  })
})

describe('PostgresStore.getCookieWithUser', () => {
  it('returns cookie + userId + email when bound', async () => {
    await store.upsertCookie('c-g-1')
    const { rawToken } = await store.issueMagicToken('g@example.com', 'c-g-1')
    await store.consumeMagicToken(hashOf(rawToken), 'c-g-1')
    const result = await store.getCookieWithUser('c-g-1')
    expect(result.cookie).toBe('c-g-1')
    expect(result.userId).not.toBeNull()
    expect(result.email).toBe('g@example.com')
  })

  it('returns null userId + email when unbound', async () => {
    await store.upsertCookie('c-g-2')
    const result = await store.getCookieWithUser('c-g-2')
    expect(result.cookie).toBe('c-g-2')
    expect(result.userId).toBeNull()
    expect(result.email).toBeNull()
  })

  it('returns all-null for nonexistent cookie', async () => {
    const result = await store.getCookieWithUser('ghost')
    expect(result).toEqual({ cookie: 'ghost', userId: null, email: null })
  })
})
