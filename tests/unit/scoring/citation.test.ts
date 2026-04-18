import { describe, expect, it } from 'vitest'
import { scoreCitation } from '../../../src/scoring/citation.ts'

describe('scoreCitation', () => {
  it('returns 100 for canonical URL (with www)', () => {
    expect(scoreCitation({ text: 'The URL is https://www.stripe.com/', domain: 'stripe.com' })).toBe(100)
  })

  it('returns 100 for canonical URL (no www)', () => {
    expect(scoreCitation({ text: 'Visit https://stripe.com/docs', domain: 'stripe.com' })).toBe(100)
  })

  it('returns 80 for same-domain subdomain URL', () => {
    expect(scoreCitation({ text: 'See https://api.stripe.com/v1', domain: 'stripe.com' })).toBe(80)
  })

  it('returns 50 for bare domain token', () => {
    expect(scoreCitation({ text: 'Check out stripe.com for payments.', domain: 'stripe.com' })).toBe(50)
  })

  it('returns 0 when domain is not mentioned at all', () => {
    expect(scoreCitation({ text: 'It is a payment processor.', domain: 'stripe.com' })).toBe(0)
  })

  it('escapes dots in regex so "stripe.com" does not match "stripexcom"', () => {
    expect(scoreCitation({ text: 'Try stripexcom instead.', domain: 'stripe.com' })).toBe(0)
  })
})
