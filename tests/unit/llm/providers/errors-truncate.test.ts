import { describe, it, expect } from 'vitest'
import { ProviderError } from '../../../../src/llm/providers/errors.ts'

describe('ProviderError message truncation', () => {
  it('truncates message bodies longer than 200 chars with an ellipsis', () => {
    const longBody = 'x'.repeat(500)
    const err = new ProviderError('claude', 500, 'server', `anthropic 500: ${longBody}`)
    expect(err.message.length).toBeLessThanOrEqual(220)
    expect(err.message.endsWith('…[truncated]')).toBe(true)
  })

  it('leaves short messages untouched', () => {
    const err = new ProviderError('claude', 500, 'server', 'anthropic 500: short')
    expect(err.message).toBe('anthropic 500: short')
  })

  it('preserves provider + status + kind fields', () => {
    const err = new ProviderError('claude', 400, 'insufficient_credit', 'a'.repeat(500))
    expect(err.provider).toBe('claude')
    expect(err.status).toBe(400)
    expect(err.kind).toBe('insufficient_credit')
  })
})
