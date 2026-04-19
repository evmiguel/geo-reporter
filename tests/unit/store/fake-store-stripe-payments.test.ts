import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore stripe_payments', () => {
  it('create + getBySessionId round-trip', async () => {
    const store = makeFakeStore()
    const g = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free' })
    await store.createStripePayment({
      gradeId: g.id, sessionId: 'cs_test_1', amountCents: 1900, currency: 'usd',
    })
    const row = await store.getStripePaymentBySessionId('cs_test_1')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('pending')
    expect(row!.gradeId).toBe(g.id)
  })

  it('updateStatus flips pending → paid', async () => {
    const store = makeFakeStore()
    const g = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free' })
    await store.createStripePayment({
      gradeId: g.id, sessionId: 'cs_test_2', amountCents: 1900, currency: 'usd',
    })
    await store.updateStripePaymentStatus('cs_test_2', { status: 'paid', amountCents: 1900, currency: 'usd' })
    const row = await store.getStripePaymentBySessionId('cs_test_2')
    expect(row!.status).toBe('paid')
  })

  it('listStripePaymentsByGrade returns all rows for a grade', async () => {
    const store = makeFakeStore()
    const g = await store.createGrade({ url: 'https://x', domain: 'x', tier: 'free' })
    await store.createStripePayment({ gradeId: g.id, sessionId: 'cs_a', amountCents: 1900, currency: 'usd' })
    await store.createStripePayment({ gradeId: g.id, sessionId: 'cs_b', amountCents: 1900, currency: 'usd' })
    const rows = await store.listStripePaymentsByGrade(g.id)
    expect(rows).toHaveLength(2)
  })

  it('getBySessionId returns null for unknown id', async () => {
    const store = makeFakeStore()
    expect(await store.getStripePaymentBySessionId('nonexistent')).toBeNull()
  })
})
