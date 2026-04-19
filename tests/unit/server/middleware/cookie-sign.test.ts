import { describe, it, expect } from 'vitest'
import { signCookie, verifyCookie, parseCookie } from '../../../../src/server/middleware/cookie-sign.ts'

const KEY = 'test-key-exactly-32-chars-long-aa'
const UUID = '1b671a64-40d5-491e-99b0-da01ff1f3341'

describe('cookie-sign', () => {
  it('signs then verifies a uuid', () => {
    const signed = signCookie(UUID, KEY)
    expect(signed.startsWith(`${UUID}.`)).toBe(true)
    expect(signed.length).toBe(UUID.length + 1 + 22)
    expect(verifyCookie(signed, KEY)).toBe(UUID)
  })

  it('rejects tampered uuid', () => {
    const signed = signCookie(UUID, KEY)
    const otherUuid = '2b671a64-40d5-491e-99b0-da01ff1f3341'
    const tampered = `${otherUuid}.${signed.split('.')[1]}`
    expect(verifyCookie(tampered, KEY)).toBe(null)
  })

  it('rejects tampered hmac', () => {
    const signed = signCookie(UUID, KEY)
    const tampered = `${UUID}.AAAAAAAAAAAAAAAAAAAAAA`
    expect(verifyCookie(tampered, KEY)).toBe(null)
  })

  it('rejects different key', () => {
    const signed = signCookie(UUID, KEY)
    expect(verifyCookie(signed, 'different-key-exactly-32-chars-bb')).toBe(null)
  })

  it('parseCookie returns plain-uuid shape for unsigned input', () => {
    expect(parseCookie(UUID)).toEqual({ kind: 'plain', uuid: UUID })
  })

  it('parseCookie returns signed shape for signed input', () => {
    const signed = signCookie(UUID, KEY)
    expect(parseCookie(signed)).toEqual({ kind: 'signed', uuid: UUID, hmac: signed.split('.')[1] })
  })

  it('parseCookie returns malformed for garbage', () => {
    expect(parseCookie('')).toEqual({ kind: 'malformed' })
    expect(parseCookie('not-a-uuid')).toEqual({ kind: 'malformed' })
    expect(parseCookie('a.b.c')).toEqual({ kind: 'malformed' })
    expect(parseCookie(`${UUID}.`)).toEqual({ kind: 'malformed' })
  })

  it('parseCookie returns malformed for non-uuid in signed shape', () => {
    expect(parseCookie('not-a-uuid.AAAAAAAAAAAAAAAAAAAAAA')).toEqual({ kind: 'malformed' })
  })
})
