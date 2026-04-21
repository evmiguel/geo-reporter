import { describe, it, expect } from 'vitest'
import { FakeStripe } from '../_helpers/fake-stripe.ts'

describe('FakeStripe.refund', () => {
  it('returns ok:true by default + records the refund', async () => {
    const stripe = new FakeStripe()
    const session = await stripe.createCheckoutSession({
      kind: 'report', gradeId: 'g1', successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await stripe.completeSession(session.id)
    const result = await stripe.refund(session.id)
    expect(result.ok).toBe(true)
    expect(stripe.refunds).toHaveLength(1)
    expect(stripe.refunds[0]!.sessionId).toBe(session.id)
  })

  it('returns ok:false when failRefundsFor was called for this session', async () => {
    const stripe = new FakeStripe()
    const session = await stripe.createCheckoutSession({
      kind: 'report', gradeId: 'g2', successUrl: 's', cancelUrl: 'c', priceId: 'p',
    })
    await stripe.completeSession(session.id)
    stripe.failRefundsFor(session.id)
    const result = await stripe.refund(session.id)
    expect(result.ok).toBe(false)
    expect(result.errorMessage).toBeTruthy()
  })
})
