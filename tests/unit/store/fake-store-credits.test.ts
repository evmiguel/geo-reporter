import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore credits', () => {
  it('getCredits returns 0 for new users', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    expect(await store.getCredits(user.id)).toBe(0)
  })

  it('grantCreditsAndMarkPaid adds to balance and flips payment status', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_c1', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_c1', user.id, 10, 2900, 'usd')
    expect(await store.getCredits(user.id)).toBe(10)
    const row = await store.getStripePaymentBySessionId('cs_c1')
    expect(row!.status).toBe('paid')
  })

  it('redeemCredit decrements balance and returns remaining', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_c2', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_c2', user.id, 10, 2900, 'usd')
    const first = await store.redeemCredit(user.id)
    expect(first).toEqual({ ok: true, remaining: 9 })
    const second = await store.redeemCredit(user.id)
    expect(second).toEqual({ ok: true, remaining: 8 })
  })

  it('redeemCredit returns ok:false when balance is 0', async () => {
    const store = makeFakeStore()
    const user = await store.upsertUser('u@x.com')
    const result = await store.redeemCredit(user.id)
    expect(result).toEqual({ ok: false })
  })

  it('getCookieWithUserAndCredits returns credits for a bound cookie', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const user = await store.upsertUser('u@x.com')
    await store.upsertCookie('c-1', user.id)
    await store.createStripePayment({
      gradeId: null, sessionId: 'cs_c3', amountCents: 2900, currency: 'usd', kind: 'credits',
    })
    await store.grantCreditsAndMarkPaid('cs_c3', user.id, 10, 2900, 'usd')
    const result = await store.getCookieWithUserAndCredits('c-1')
    expect(result.credits).toBe(10)
    expect(result.userId).toBe(user.id)
    expect(result.email).toBe('u@x.com')
  })

  it('getCookieWithUserAndCredits returns 0 credits for unbound cookie', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-2')
    const result = await store.getCookieWithUserAndCredits('c-2')
    expect(result.credits).toBe(0)
    expect(result.userId).toBeNull()
  })
})
