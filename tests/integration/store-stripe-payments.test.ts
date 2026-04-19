import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => { testDb = await startTestDb(); store = new PostgresStore(testDb.db) }, 60_000)
afterAll(async () => { await testDb.stop() })
beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, cookies, users CASCADE`)
})

describe('PostgresStore stripe_payments', () => {
  it('create + getBySessionId', async () => {
    const grade = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_test_int_1', amountCents: 1900, currency: 'usd',
    })
    const row = await store.getStripePaymentBySessionId('cs_test_int_1')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('pending')
  })

  it('duplicate sessionId INSERT raises (UNIQUE constraint)', async () => {
    const grade = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_dup', amountCents: 1900, currency: 'usd',
    })
    await expect(store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_dup', amountCents: 1900, currency: 'usd',
    })).rejects.toThrow()
  })

  it('updateStatus to paid', async () => {
    const grade = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_u1', amountCents: 1900, currency: 'usd',
    })
    await store.updateStripePaymentStatus('cs_u1', { status: 'paid', amountCents: 1900, currency: 'usd' })
    const row = await store.getStripePaymentBySessionId('cs_u1')
    expect(row!.status).toBe('paid')
  })

  it('listStripePaymentsByGrade', async () => {
    const grade = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.createStripePayment({ gradeId: grade.id, sessionId: 'cs_l1', amountCents: 1900, currency: 'usd' })
    await store.createStripePayment({ gradeId: grade.id, sessionId: 'cs_l2', amountCents: 1900, currency: 'usd' })
    const rows = await store.listStripePaymentsByGrade(grade.id)
    expect(rows).toHaveLength(2)
  })
})
