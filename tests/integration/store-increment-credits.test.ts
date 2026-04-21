import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.incrementCredits', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('increments a user\'s credits and returns the new balance', async () => {
    const user = await store.upsertUser('plus@example.com')
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_seed', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_seed', user.id, 10, 2900, 'usd')
    expect(await store.getCredits(user.id)).toBe(10)

    const after = await store.incrementCredits(user.id, 1)
    expect(after).toBe(11)
    expect(await store.getCredits(user.id)).toBe(11)
  })

  it('handles negative delta (decrement; used nowhere today but safe)', async () => {
    const user = await store.upsertUser('minus@example.com')
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_minus', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_minus', user.id, 5, 2900, 'usd')
    const after = await store.incrementCredits(user.id, -2)
    expect(after).toBe(3)
  })

  it('throws on missing user', async () => {
    await expect(store.incrementCredits('00000000-0000-0000-0000-000000000000', 1))
      .rejects.toThrow()
  })
})
