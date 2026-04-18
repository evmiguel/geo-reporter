import { describe, expect, it } from 'vitest'
import { GeminiProvider } from '../../../../src/llm/providers/gemini.ts'

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 },
}

function mockFetch(status: number, body: unknown) {
  return async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

describe('GeminiProvider', () => {
  it('POSTs with key query parameter', async () => {
    let url = ''
    const p = new GeminiProvider({
      apiKey: 'abc',
      fetchFn: async (u) => {
        url = String(u)
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi')
    expect(url).toContain('generativelanguage.googleapis.com')
    expect(url).toContain(':generateContent?key=abc')
  })

  it('joins multiple text parts into one response', async () => {
    const p = new GeminiProvider({ apiKey: 'k', fetchFn: mockFetch(200, OK_BODY) })
    const r = await p.query('hi')
    expect(r.text).toBe('hello world')
    expect(r.inputTokens).toBe(4)
    expect(r.outputTokens).toBe(3)
  })

  it('returns empty string when candidates are empty', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchFn: mockFetch(200, { candidates: [], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 } }),
    })
    const r = await p.query('hi')
    expect(r.text).toBe('')
  })

  it('maps maxTokens → maxOutputTokens in generationConfig', async () => {
    let body: unknown
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi', { maxTokens: 100, temperature: 0 })
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 100, temperature: 0 } })
  })

  it('throws ProviderError(server) on 500', async () => {
    const p = new GeminiProvider({ apiKey: 'k', fetchFn: mockFetch(500, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ provider: 'gemini', kind: 'server' })
  })

  it('throws ProviderError(network) when fetch throws', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetchFn: async () => { throw new Error('dns') },
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'network' })
  })
})
