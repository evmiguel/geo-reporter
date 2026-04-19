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

describe('PostgresStore.consumeMagicToken', () => {
  it('binds the CLICKING cookie, not the issuing one', async () => {
    await store.upsertCookie('cookie-issuer')
    await store.upsertCookie('cookie-clicker')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-issuer')
    const result = await store.consumeMagicToken(hashOf(rawToken), 'cookie-clicker')
    if (!result.ok) throw new Error('expected ok')
    const clicker = await store.getCookie('cookie-clicker')
    const issuer = await store.getCookie('cookie-issuer')
    expect(clicker!.userId).toBe(result.userId)
    expect(issuer!.userId).toBeNull()
  })

  it('rejects a second consume of the same token', async () => {
    await store.upsertCookie('cookie-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-1')
    const hash = hashOf(rawToken)
    const first = await store.consumeMagicToken(hash, 'cookie-1')
    expect(first.ok).toBe(true)
    const second = await store.consumeMagicToken(hash, 'cookie-1')
    expect(second).toEqual({ ok: false })
  })

  it('rejects an expired token', async () => {
    await store.upsertCookie('cookie-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-1')
    await testDb.db.execute(sql`UPDATE magic_tokens SET expires_at = now() - interval '1 minute'`)
    const result = await store.consumeMagicToken(hashOf(rawToken), 'cookie-1')
    expect(result).toEqual({ ok: false })
  })

  it('reuses user for second verify of same email', async () => {
    await store.upsertCookie('cookie-a')
    await store.upsertCookie('cookie-b')
    const first = await store.issueMagicToken('user@example.com', 'cookie-a')
    const firstR = await store.consumeMagicToken(hashOf(first.rawToken), 'cookie-a')
    const second = await store.issueMagicToken('user@example.com', 'cookie-b')
    const secondR = await store.consumeMagicToken(hashOf(second.rawToken), 'cookie-b')
    if (!firstR.ok || !secondR.ok) throw new Error('expected ok')
    expect(firstR.userId).toBe(secondR.userId)
  })
})
