import { describe, expect, it } from 'vitest'
import { OpenAIProvider } from '../../../../src/llm/providers/openai.ts'

const OK_BODY = {
  choices: [{ message: { content: 'hello' } }],
  usage: { prompt_tokens: 12, completion_tokens: 7 },
}

function mockFetch(status: number, body: unknown) {
  return async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

describe('OpenAIProvider', () => {
  it('POSTs with Bearer auth to /v1/chat/completions', async () => {
    let url = ''
    let headers: Record<string, string> = {}
    const p = new OpenAIProvider({
      apiKey: 'sk-o',
      fetchFn: async (u, init) => {
        url = String(u)
        headers = init?.headers as Record<string, string>
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi')
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(headers['authorization']).toBe('Bearer sk-o')
  })

  it('parses content + token counts', async () => {
    const p = new OpenAIProvider({ apiKey: 'k', fetchFn: mockFetch(200, OK_BODY) })
    const r = await p.query('hi')
    expect(r.text).toBe('hello')
    expect(r.inputTokens).toBe(12)
    expect(r.outputTokens).toBe(7)
  })

  it('returns empty text when choices[0].message.content is missing', async () => {
    const p = new OpenAIProvider({
      apiKey: 'k',
      fetchFn: mockFetch(200, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }),
    })
    const r = await p.query('hi')
    expect(r.text).toBe('')
  })

  it('throws ProviderError(rate_limit) on 429', async () => {
    const p = new OpenAIProvider({ apiKey: 'k', fetchFn: mockFetch(429, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ provider: 'gpt', kind: 'rate_limit' })
  })

  it('throws ProviderError(auth) on 403', async () => {
    const p = new OpenAIProvider({ apiKey: 'k', fetchFn: mockFetch(403, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('throws ProviderError(network) on fetch throwing', async () => {
    const p = new OpenAIProvider({
      apiKey: 'k',
      fetchFn: async () => { throw new Error('econnrefused') },
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'network' })
  })
})
