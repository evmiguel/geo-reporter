import { describe, it, expect, vi } from 'vitest'
import crypto from 'node:crypto'
import { validateToken } from '../../../src/report/token.ts'

describe('validateToken', () => {
  const good = '0'.repeat(64)

  it('returns true when tokens match exactly', () => {
    expect(validateToken(good, good)).toBe(true)
  })

  it('returns false when tokens differ', () => {
    expect(validateToken(good, '1'.repeat(64))).toBe(false)
  })

  it('returns false when given token is shorter than stored', () => {
    expect(validateToken('0'.repeat(10), good)).toBe(false)
  })

  it('returns false when given token is longer than stored', () => {
    expect(validateToken('0'.repeat(128), good)).toBe(false)
  })

  it('returns false for empty token', () => {
    expect(validateToken('', good)).toBe(false)
  })

  it('short-circuits on length mismatch before timingSafeEqual', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    validateToken('short', good)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('calls timingSafeEqual when lengths match', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    validateToken(good, good)
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })
})
