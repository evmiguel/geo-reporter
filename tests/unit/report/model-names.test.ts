import { describe, it, expect } from 'vitest'
import { friendlyModelName } from '../../../src/report/model-names.ts'

describe('friendlyModelName', () => {
  it('maps claude-sonnet-4-6', () => {
    expect(friendlyModelName('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6')
  })
  it('maps gpt-4.1-mini', () => {
    expect(friendlyModelName('gpt-4.1-mini')).toBe('GPT-4.1 mini')
  })
  it('maps gemini-2.5-flash', () => {
    expect(friendlyModelName('gemini-2.5-flash')).toBe('Gemini 2.5 Flash')
  })
  it('maps sonar', () => {
    expect(friendlyModelName('sonar')).toBe('Perplexity Sonar')
  })
  it('returns raw ID for unknown models', () => {
    expect(friendlyModelName('unknown-model-xyz')).toBe('unknown-model-xyz')
  })
})
