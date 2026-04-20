import { describe, it, expect } from 'vitest'
import { isPrivateAddress, SSRFBlockedError } from '../../../src/scraper/ssrf.ts'

describe('isPrivateAddress', () => {
  it('rejects RFC 1918 ranges', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.255.255.255')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('172.31.255.255')).toBe(true)
    expect(isPrivateAddress('192.168.1.1')).toBe(true)
  })

  it('rejects loopback', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('127.255.255.255')).toBe(true)
  })

  it('rejects link-local + cloud metadata IPs', () => {
    expect(isPrivateAddress('169.254.0.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
  })

  it('rejects CGNAT', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true)
    expect(isPrivateAddress('100.127.255.255')).toBe(true)
  })

  it('rejects 0.0.0.0/8 + multicast', () => {
    expect(isPrivateAddress('0.0.0.0')).toBe(true)
    expect(isPrivateAddress('224.0.0.1')).toBe(true)
  })

  it('rejects IPv6 loopback, link-local, ULA', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('fc00::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
  })

  it('allows public IPs', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})

describe('SSRFBlockedError', () => {
  it('carries host + address in the error message', () => {
    const e = new SSRFBlockedError('evil.test', '10.0.0.1')
    expect(e.message).toContain('evil.test')
    expect(e.message).toContain('10.0.0.1')
  })
})
