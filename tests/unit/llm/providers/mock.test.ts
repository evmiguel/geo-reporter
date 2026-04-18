import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'

describe('MockProvider', () => {
  it('returns a string response for an exact-match prompt', async () => {
    const p = new MockProvider({ id: 'claude', responses: { hello: 'hi there' } })
    const r = await p.query('hello')
    expect(r.text).toBe('hi there')
    expect(r.inputTokens).toBeGreaterThan(0)
    expect(r.outputTokens).toBeGreaterThan(0)
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  it('returns a function-computed response', async () => {
    const p = new MockProvider({ id: 'gpt', responses: (prompt) => `echo:${prompt}` })
    const r = await p.query('ping')
    expect(r.text).toBe('echo:ping')
  })

  it('records every call with prompt + opts', async () => {
    const p = new MockProvider({ id: 'mock', responses: () => 'ok' })
    await p.query('a', { temperature: 0 })
    await p.query('b', { maxTokens: 10 })
    expect(p.calls).toEqual([
      { prompt: 'a', opts: { temperature: 0 } },
      { prompt: 'b', opts: { maxTokens: 10 } },
    ])
  })

  it('throws when no match and no default', async () => {
    const p = new MockProvider({ id: 'mock', responses: { x: 'y' } })
    await expect(p.query('nope')).rejects.toThrow(/no match/i)
  })

  it('throws when failWith is set', async () => {
    const p = new MockProvider({ id: 'mock', responses: {}, failWith: 'boom' })
    await expect(p.query('anything')).rejects.toThrow('boom')
  })

  it('honours AbortSignal by rejecting with AbortError-like error', async () => {
    const p = new MockProvider({ id: 'mock', responses: () => 'ok', latencyMs: 20 })
    const ctrl = new AbortController()
    const pending = p.query('x', { signal: ctrl.signal })
    ctrl.abort()
    await expect(pending).rejects.toThrow(/abort/i)
  })

  it('has id readable from the outside', () => {
    const p = new MockProvider({ id: 'perplexity', responses: {} })
    expect(p.id).toBe('perplexity')
  })
})
