import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.deleteUser', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('cascades grade delete + anonymizes stripe_payments + keeps cookies unbound', async () => {
    const user = await store.upsertUser('delete-me@example.com')
    const cookie = `cookie-${Date.now()}`
    await store.upsertCookie(cookie, user.id)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie, userId: user.id, status: 'done',
    })
    await store.createScrape({ gradeId: grade.id, rendered: false, html: '<html/>', text: 't', structured: {} as never })
    await store.createProbe({ gradeId: grade.id, category: 'seo', provider: null, prompt: 'p', response: 'r', score: 100, metadata: {} })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_abc', amountCents: 1900, currency: 'usd', userId: user.id,
    })
    await store.updateStripePaymentStatus('cs_abc', { status: 'paid' })
    // also issue a magic token — purge path
    await store.issueMagicToken('delete-me@example.com', cookie)

    await store.deleteUser(user.id, 'delete-me@example.com')

    // Grade + cascades gone
    const probes = await store.listProbes(grade.id)
    expect(probes).toEqual([])
    // Cookie exists but unbound
    const row = await store.getCookieWithUserAndCredits(cookie)
    expect(row.userId).toBeNull()
    // Stripe payment anonymized
    const pay = await store.getStripePaymentBySessionId('cs_abc')
    expect(pay).not.toBeNull()
    expect(pay!.userId).toBeNull()
    expect(pay!.gradeId).toBeNull()
  }, 60_000)

  it('throws when expectedEmail does not match the user row', async () => {
    const user = await store.upsertUser(`correct-${Date.now()}@example.com`)
    await expect(store.deleteUser(user.id, 'wrong@example.com')).rejects.toThrow()
  }, 60_000)
})
