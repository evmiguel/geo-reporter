import { describe, it, expect } from 'vitest'
import { redactUrl } from '../../../../src/server/middleware/request-log.ts'

describe('redactUrl', () => {
  it('replaces ?t=<token> with ?t=REDACTED', () => {
    expect(redactUrl('/report/abc?t=secret123')).toBe('/report/abc?t=REDACTED')
  })
  it('replaces ?token=<token> too', () => {
    expect(redactUrl('/auth/verify?token=abc')).toBe('/auth/verify?token=REDACTED')
  })
  it('preserves other query params', () => {
    expect(redactUrl('/report/abc?foo=bar&t=secret&baz=qux'))
      .toBe('/report/abc?foo=bar&t=REDACTED&baz=qux')
  })
  it('no-op when no sensitive param present', () => {
    expect(redactUrl('/report/abc?foo=bar')).toBe('/report/abc?foo=bar')
  })
  it('no-op when no query string', () => {
    expect(redactUrl('/healthz')).toBe('/healthz')
  })
})
