import { describe, expect, it } from 'vitest'
import { scoreDiscoverability, brandFromDomain } from '../../../src/scoring/discoverability.ts'

describe('brandFromDomain', () => {
  it('extracts brand from TLD domain', () => {
    expect(brandFromDomain('stripe.com')).toBe('Stripe')
  })
  it('strips leading www', () => {
    expect(brandFromDomain('www.stripe.com')).toBe('Stripe')
  })
  it('takes second-to-last segment from subdomain', () => {
    expect(brandFromDomain('api.stripe.com')).toBe('Stripe')
  })
  it('handles single-segment hostnames', () => {
    expect(brandFromDomain('localhost')).toBe('Localhost')
  })
})

describe('scoreDiscoverability', () => {
  it('returns 0 when neither brand nor domain is mentioned', () => {
    expect(scoreDiscoverability({ text: 'It is a tool.', brand: 'Stripe', domain: 'stripe.com' })).toBe(0)
  })

  it('returns 50 for bare brand mention', () => {
    expect(scoreDiscoverability({ text: 'Stripe is used.', brand: 'Stripe', domain: 'stripe.com' })).toBe(50)
  })

  it('returns 30 for bare domain mention without brand', () => {
    expect(scoreDiscoverability({ text: 'See stripe.com.', brand: 'Stripe', domain: 'stripe.com' })).toBe(30)
  })

  it('adds brand+domain to 80', () => {
    expect(scoreDiscoverability({ text: 'Stripe lives at stripe.com.', brand: 'Stripe', domain: 'stripe.com' })).toBe(80)
  })

  it('bumps to 80 when brand is mentioned with a recommendation phrase (no URL)', () => {
    expect(scoreDiscoverability({
      text: 'Stripe is the leading payment processor.',
      brand: 'Stripe', domain: 'stripe.com',
    })).toBe(80)
  })

  it('bumps to 100 for brand + URL + recommendation', () => {
    expect(scoreDiscoverability({
      text: 'Stripe (stripe.com) is the industry standard for payments.',
      brand: 'Stripe', domain: 'stripe.com',
    })).toBe(100)
  })

  it('suppresses recommendation bonus when brand appears in list of alternatives', () => {
    expect(scoreDiscoverability({
      text: 'Popular options include Stripe, Square, Adyen for payments.',
      brand: 'Stripe', domain: 'stripe.com',
    })).toBe(50)
  })

  it('clamps score to 0–100', () => {
    const s = scoreDiscoverability({
      text: 'Stripe (stripe.com) is the de-facto industry standard, the most widely used.',
      brand: 'Stripe', domain: 'stripe.com',
    })
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(100)
  })
})
