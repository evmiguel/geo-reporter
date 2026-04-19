import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let testDb: TestDb
let store: PostgresStore

beforeAll(async () => { testDb = await startTestDb(); store = new PostgresStore(testDb.db) }, 60_000)
afterAll(async () => { await testDb.stop() })
beforeEach(async () => {
  await testDb.db.execute(sql`TRUNCATE grades, stripe_payments, cookies, users, magic_tokens CASCADE`)
})

describe('PostgresStore credits', () => {
  it('getCredits returns 0 initially; grantCreditsAndMarkPaid adds', async () => {
    const user = await store.upsertUser('u@example.com')
    expect(await store.getCredits(user.id)).toBe(0)
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_int_1', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_int_1', user.id, 10, 2900, 'usd')
    expect(await store.getCredits(user.id)).toBe(10)
  })

  it('redeemCredit decrements; returns ok:false on empty', async () => {
    const user = await store.upsertUser('u@example.com')
    const empty = await store.redeemCredit(user.id)
    expect(empty).toEqual({ ok: false })

    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_int_2', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_int_2', user.id, 3, 2900, 'usd')

    const r1 = await store.redeemCredit(user.id)
    const r2 = await store.redeemCredit(user.id)
    const r3 = await store.redeemCredit(user.id)
    const r4 = await store.redeemCredit(user.id)

    expect(r1).toEqual({ ok: true, remaining: 2 })
    expect(r2).toEqual({ ok: true, remaining: 1 })
    expect(r3).toEqual({ ok: true, remaining: 0 })
    expect(r4).toEqual({ ok: false })
  })

  it('concurrent redeems on balance=1 — only one wins', async () => {
    const user = await store.upsertUser('u@example.com')
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_race', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_race', user.id, 1, 2900, 'usd')

    const [a, b] = await Promise.all([
      store.redeemCredit(user.id),
      store.redeemCredit(user.id),
    ])
    const oks = [a, b].filter((r) => r.ok).length
    const fails = [a, b].filter((r) => !r.ok).length
    expect(oks).toBe(1)
    expect(fails).toBe(1)
    expect(await store.getCredits(user.id)).toBe(0)
  })

  it('getCookieWithUserAndCredits joins correctly', async () => {
    const user = await store.upsertUser('u@example.com')
    await store.upsertCookie('c-1', user.id)
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_int_3', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_int_3', user.id, 5, 2900, 'usd')
    const result = await store.getCookieWithUserAndCredits('c-1')
    expect(result.credits).toBe(5)
    expect(result.email).toBe('u@example.com')
    expect(result.userId).toBe(user.id)
  })
})
