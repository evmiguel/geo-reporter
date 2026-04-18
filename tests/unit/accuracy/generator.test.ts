import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { generateQuestion } from '../../../src/accuracy/generator.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme', description: 'Widgets', h1: 'Welcome', bodyExcerpt: 'We sell widgets since 1902.',
}

describe('generateQuestion', () => {
  it('returns the generator response as the question', async () => {
    const gen = new MockProvider({ id: 'gpt', responses: () => 'When was Acme founded?' })
    const result = await generateQuestion({ generator: gen, groundTruth: GT })
    expect(result.question).toBe('When was Acme founded?')
    expect(result.prompt).toContain('factual question')
    expect(result.response).toBe('When was Acme founded?')
  })

  it('strips leading/trailing quotes and whitespace', async () => {
    const gen = new MockProvider({ id: 'gpt', responses: () => '  "When was Acme founded?"  ' })
    const result = await generateQuestion({ generator: gen, groundTruth: GT })
    expect(result.question).toBe('When was Acme founded?')
  })

  it('re-throws provider errors', async () => {
    const gen = new MockProvider({ id: 'gpt', responses: {}, failWith: 'generator down' })
    await expect(generateQuestion({ generator: gen, groundTruth: GT })).rejects.toThrow('generator down')
  })
})
