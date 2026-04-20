import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../../src/llm/providers/anthropic.ts'
import { OpenAIProvider } from '../../../src/llm/providers/openai.ts'
import { GeminiProvider } from '../../../src/llm/providers/gemini.ts'
import { PerplexityProvider } from '../../../src/llm/providers/perplexity.ts'
import { MockProvider } from '../../../src/llm/providers/mock.ts'

describe('Provider.model', () => {
  it('Anthropic exposes configured model', () => {
    const p = new AnthropicProvider({ apiKey: 'test', model: 'claude-test-123' })
    expect(p.model).toBe('claude-test-123')
  })

  it('Anthropic exposes default model when not overridden', () => {
    const p = new AnthropicProvider({ apiKey: 'test' })
    expect(p.model).toBe('claude-sonnet-4-6')
  })

  it('OpenAI exposes configured model', () => {
    const p = new OpenAIProvider({ apiKey: 'test', model: 'gpt-test' })
    expect(p.model).toBe('gpt-test')
  })

  it('Gemini exposes configured model', () => {
    const p = new GeminiProvider({ apiKey: 'test', model: 'gemini-test' })
    expect(p.model).toBe('gemini-test')
  })

  it('Perplexity exposes configured model', () => {
    const p = new PerplexityProvider({ apiKey: 'test', model: 'sonar-test' })
    expect(p.model).toBe('sonar-test')
  })

  it('Mock exposes synthetic model name', () => {
    const p = new MockProvider({ id: 'claude', responses: { default: 'x' } })
    expect(p.model).toBe('mock:claude')
  })
})
