import { describe, expect, it } from 'vitest'
import { ProviderError, classifyStatus } from '../../../../src/llm/providers/errors.ts'

describe('classifyStatus', () => {
  it('maps 429 to rate_limit', () => {
    expect(classifyStatus(429)).toBe('rate_limit')
  })
  it('maps 401/403 to auth', () => {
    expect(classifyStatus(401)).toBe('auth')
    expect(classifyStatus(403)).toBe('auth')
  })
  it('maps 5xx to server', () => {
    expect(classifyStatus(500)).toBe('server')
    expect(classifyStatus(503)).toBe('server')
  })
  it('maps 408/504 to timeout', () => {
    expect(classifyStatus(408)).toBe('timeout')
    expect(classifyStatus(504)).toBe('timeout')
  })
  it('maps other 4xx to unknown', () => {
    expect(classifyStatus(400)).toBe('unknown')
    expect(classifyStatus(422)).toBe('unknown')
  })
})

describe('ProviderError', () => {
  it('carries provider, status, kind, message', () => {
    const err = new ProviderError('claude', 429, 'rate_limit', 'too many requests')
    expect(err.provider).toBe('claude')
    expect(err.status).toBe(429)
    expect(err.kind).toBe('rate_limit')
    expect(err.message).toBe('too many requests')
    expect(err).toBeInstanceOf(Error)
  })
})
