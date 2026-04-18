import { describe, expect, it } from 'vitest'
import { buildProviders } from '../../../../src/llm/providers/factory.ts'

describe('buildProviders', () => {
  it('returns all four direct providers when all keys are set', () => {
    const p = buildProviders({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      GEMINI_API_KEY: 'c',
      PERPLEXITY_API_KEY: 'd',
    })
    expect(p.claude.id).toBe('claude')
    expect(p.gpt.id).toBe('gpt')
    expect(p.gemini.id).toBe('gemini')
    expect(p.perplexity.id).toBe('perplexity')
  })

  it('throws a clear error when a key is missing', () => {
    expect(() => buildProviders({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      GEMINI_API_KEY: '',
      PERPLEXITY_API_KEY: 'd',
    })).toThrow(/GEMINI_API_KEY/)
  })
})
