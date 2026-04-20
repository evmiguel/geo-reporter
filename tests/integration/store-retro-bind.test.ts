import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => { testDb = await startTestDb(); store = new PostgresStore(testDb.db) }, 120_000)
afterAll(async () => { await testDb.stop() })
beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE grades, magic_tokens, cookies, users CASCADE`)
})

const hashOf = (raw: string): string => createHash('sha256').update(raw).digest('hex')

describe('PostgresStore.consumeMagicToken retroactive grade binding', () => {
  it('binds grades under the clicking cookie to the verifying user', async () => {
    await store.upsertCookie('c-click')
    const g = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: 'c-click', userId: null, status: 'done',
    })
    const { rawToken } = await store.issueMagicToken('retro@example.com', 'c-click')

    const out = await store.consumeMagicToken(hashOf(rawToken), 'c-click')
    if (!out.ok) throw new Error('expected ok')

    const refreshed = await store.getGrade(g.id)
    expect(refreshed?.userId).toBe(out.userId)
  })

  it('binds grades under cookies previously bound to this user', async () => {
    // Set up: user already verified once under c-phone. New verify on c-laptop.
    const user = await store.upsertUser('multi@example.com')
    await store.upsertCookie('c-phone', user.id)
    const phoneGrade = await store.createGrade({
      url: 'https://phone', domain: 'phone', tier: 'free', cookie: 'c-phone', userId: null, status: 'done',
    })
    await store.upsertCookie('c-laptop')
    const laptopGrade = await store.createGrade({
      url: 'https://laptop', domain: 'laptop', tier: 'free', cookie: 'c-laptop', userId: null, status: 'done',
    })
    const { rawToken } = await store.issueMagicToken('multi@example.com', 'c-laptop')

    const out = await store.consumeMagicToken(hashOf(rawToken), 'c-laptop')
    if (!out.ok) throw new Error('expected ok')

    const phone = await store.getGrade(phoneGrade.id)
    const laptop = await store.getGrade(laptopGrade.id)
    expect(phone?.userId).toBe(user.id)
    expect(laptop?.userId).toBe(user.id)
  })

  it('does not stomp grades already owned by a different user', async () => {
    const other = await store.upsertUser('other@example.com')
    await store.upsertCookie('c-other', other.id)
    const otherGrade = await store.createGrade({
      url: 'https://other', domain: 'other', tier: 'free',
      cookie: 'c-other', userId: other.id, status: 'done',
    })
    await store.upsertCookie('c-verify')
    const { rawToken } = await store.issueMagicToken('stomper@example.com', 'c-verify')
    await store.consumeMagicToken(hashOf(rawToken), 'c-verify')

    const fresh = await store.getGrade(otherGrade.id)
    expect(fresh?.userId).toBe(other.id)
  })
})
