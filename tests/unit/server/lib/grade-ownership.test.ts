import { describe, it, expect } from 'vitest'
import { isOwnedBy } from '../../../../src/server/lib/grade-ownership.ts'

describe('isOwnedBy', () => {
  it('allows when cookie matches', () => {
    expect(isOwnedBy(
      { cookie: 'c1', userId: null },
      { cookie: 'c1', userId: null },
    )).toBe(true)
  })
  it('allows when userId matches even if cookies differ', () => {
    expect(isOwnedBy(
      { cookie: 'c-old', userId: 'u1' },
      { cookie: 'c-new', userId: 'u1' },
    )).toBe(true)
  })
  it('denies when neither cookie nor userId match', () => {
    expect(isOwnedBy(
      { cookie: 'c1', userId: 'u1' },
      { cookie: 'c2', userId: 'u2' },
    )).toBe(false)
  })
  it('denies when caller is anonymous and cookie differs', () => {
    expect(isOwnedBy(
      { cookie: 'c-old', userId: 'u1' },
      { cookie: 'c-new', userId: null },
    )).toBe(false)
  })
  it('does not allow userId=null match (null must never count as a wildcard)', () => {
    expect(isOwnedBy(
      { cookie: 'c1', userId: null },
      { cookie: 'c2', userId: null },
    )).toBe(false)
  })
})
