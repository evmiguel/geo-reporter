import { describe, expect, it } from 'vitest'
import { buildProviders } from '../../../../src/llm/providers/factory.ts'
import { FallbackProvider } from '../../../../src/llm/providers/fallback.ts'

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

describe('buildProviders — OpenRouter fallback', () => {
  const baseKeys = {
    ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o',
    GEMINI_API_KEY: 'sk-g', PERPLEXITY_API_KEY: 'sk-p',
  }

  it('returns direct providers when OPENROUTER_API_KEY is unset', () => {
    const providers = buildProviders(baseKeys)
    expect(providers.claude).not.toBeInstanceOf(FallbackProvider)
    expect(providers.gpt).not.toBeInstanceOf(FallbackProvider)
    expect(providers.gemini).not.toBeInstanceOf(FallbackProvider)
    expect(providers.perplexity).not.toBeInstanceOf(FallbackProvider)
  })

  it('wraps claude/gpt/gemini with FallbackProvider when OPENROUTER_API_KEY is set', () => {
    const providers = buildProviders({ ...baseKeys, OPENROUTER_API_KEY: 'or-key' })
    expect(providers.claude).toBeInstanceOf(FallbackProvider)
    expect(providers.gpt).toBeInstanceOf(FallbackProvider)
    expect(providers.gemini).toBeInstanceOf(FallbackProvider)
    // IDs are preserved through the wrapper
    expect(providers.claude.id).toBe('claude')
    expect(providers.gpt.id).toBe('gpt')
    expect(providers.gemini.id).toBe('gemini')
  })

  it('does NOT wrap perplexity (OpenRouter does not proxy it)', () => {
    const providers = buildProviders({ ...baseKeys, OPENROUTER_API_KEY: 'or-key' })
    expect(providers.perplexity).not.toBeInstanceOf(FallbackProvider)
    expect(providers.perplexity.id).toBe('perplexity')
  })
})
