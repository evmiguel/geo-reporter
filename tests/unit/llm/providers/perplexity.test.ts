import { describe, expect, it } from 'vitest'
import { PerplexityProvider } from '../../../../src/llm/providers/perplexity.ts'

const OK_BODY = {
  choices: [{ message: { content: 'answer' } }],
  usage: { prompt_tokens: 8, completion_tokens: 4 },
}

function mockFetch(status: number, body: unknown) {
  return async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

describe('PerplexityProvider', () => {
  it('POSTs with Bearer auth to /chat/completions', async () => {
    let url = ''
    let headers: Record<string, string> = {}
    const p = new PerplexityProvider({
      apiKey: 'pplx-x',
      fetchFn: async (u, init) => {
        url = String(u)
        headers = init?.headers as Record<string, string>
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi')
    expect(url).toBe('https://api.perplexity.ai/chat/completions')
    expect(headers['authorization']).toBe('Bearer pplx-x')
  })

  it('parses content + token counts', async () => {
    const p = new PerplexityProvider({ apiKey: 'k', fetchFn: mockFetch(200, OK_BODY) })
    const r = await p.query('hi')
    expect(r.text).toBe('answer')
    expect(r.inputTokens).toBe(8)
    expect(r.outputTokens).toBe(4)
  })

  it('throws ProviderError(rate_limit) on 429', async () => {
    const p = new PerplexityProvider({ apiKey: 'k', fetchFn: mockFetch(429, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ provider: 'perplexity', kind: 'rate_limit' })
  })

  it('throws ProviderError(server) on 502', async () => {
    const p = new PerplexityProvider({ apiKey: 'k', fetchFn: mockFetch(502, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'server' })
  })

  it('throws ProviderError(network) when fetch throws', async () => {
    const p = new PerplexityProvider({
      apiKey: 'k',
      fetchFn: async () => { throw new Error('reset') },
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'network' })
  })
})
