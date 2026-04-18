import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { runStaticProbe } from '../../../../src/llm/flows/static-probe.ts'

describe('runStaticProbe', () => {
  it('returns response + token counts when no scorer is supplied', async () => {
    const provider = new MockProvider({ id: 'claude', responses: () => 'hello' })
    const r = await runStaticProbe({ provider, prompt: 'hi' })
    expect(r.response).toBe('hello')
    expect(r.prompt).toBe('hi')
    expect(r.score).toBeNull()
    expect(r.scoreRationale).toBeNull()
    expect(r.inputTokens).toBeGreaterThan(0)
  })

  it('applies scorer when supplied', async () => {
    const provider = new MockProvider({ id: 'claude', responses: () => 'a response' })
    const r = await runStaticProbe({
      provider,
      prompt: 'hi',
      scorer: (resp) => ({ score: resp.length, rationale: `len=${resp.length}` }),
    })
    expect(r.score).toBe('a response'.length)
    expect(r.scoreRationale).toBe(`len=${'a response'.length}`)
  })

  it('propagates errors from provider.query', async () => {
    const provider = new MockProvider({ id: 'claude', responses: {}, failWith: 'boom' })
    await expect(runStaticProbe({ provider, prompt: 'x' })).rejects.toThrow('boom')
  })
})
