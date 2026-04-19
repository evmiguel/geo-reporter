import { describe, it, expect, vi } from 'vitest'
import { OpenRouterProvider } from '../../../../src/llm/providers/openrouter.ts'
import { ProviderError } from '../../../../src/llm/providers/errors.ts'

function mockFetch(factory: () => Response) {
  return vi.fn().mockImplementation(async () => factory())
}

function okResponse(body: unknown) {
  return () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function errResponse(status: number, body: string) {
  return () => new Response(body, { status })
}

const FAKE_RESPONSE_BODY = {
  choices: [{ message: { content: 'hello from openrouter' } }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
  model: 'google/gemini-2.5-pro',
}

describe('OpenRouterProvider', () => {
  it('claims the logical provider id', () => {
    const p = new OpenRouterProvider({ logicalProvider: 'gemini', apiKey: 'or-key', fetchFn: mockFetch(okResponse(FAKE_RESPONSE_BODY)) })
    expect(p.id).toBe('gemini')
  })

  it('posts to the OpenRouter chat/completions endpoint with the mapped model', async () => {
    const fetchFn = mockFetch(okResponse(FAKE_RESPONSE_BODY))
    const p = new OpenRouterProvider({ logicalProvider: 'gemini', apiKey: 'or-key', fetchFn })
    await p.query('hi')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as { model: string; messages: { role: string; content: string }[] }
    expect(body.model).toBe('google/gemini-2.5-pro')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer or-key')
  })

  it('maps claude + gpt to their OpenRouter model ids', async () => {
    const fetchFn = mockFetch(okResponse(FAKE_RESPONSE_BODY))
    const claude = new OpenRouterProvider({ logicalProvider: 'claude', apiKey: 'or', fetchFn })
    const gpt = new OpenRouterProvider({ logicalProvider: 'gpt', apiKey: 'or', fetchFn })
    await claude.query('x')
    await gpt.query('x')
    const bodyA = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as { model: string }
    const bodyB = JSON.parse((fetchFn.mock.calls[1]![1] as RequestInit).body as string) as { model: string }
    expect(bodyA.model).toMatch(/^anthropic\/claude/)
    expect(bodyB.model).toMatch(/^openai\/gpt/)
  })

  it('allows model override via options', async () => {
    const fetchFn = mockFetch(okResponse(FAKE_RESPONSE_BODY))
    const p = new OpenRouterProvider({ logicalProvider: 'gemini', apiKey: 'or', model: 'custom/model', fetchFn })
    await p.query('x')
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as { model: string }
    expect(body.model).toBe('custom/model')
  })

  it('returns { text, ms, inputTokens, outputTokens } on success', async () => {
    const fetchFn = mockFetch(okResponse(FAKE_RESPONSE_BODY))
    const p = new OpenRouterProvider({ logicalProvider: 'gemini', apiKey: 'or', fetchFn })
    const result = await p.query('hi')
    expect(result.text).toBe('hello from openrouter')
    expect(result.inputTokens).toBe(12)
    expect(result.outputTokens).toBe(4)
    expect(result.ms).toBeGreaterThanOrEqual(0)
  })

  it('throws ProviderError on non-ok HTTP response', async () => {
    const fetchFn = mockFetch(errResponse(503, 'upstream down'))
    const p = new OpenRouterProvider({ logicalProvider: 'gemini', apiKey: 'or', fetchFn })
    await expect(p.query('hi')).rejects.toBeInstanceOf(ProviderError)
  })

  it('ProviderError carries status 503 and kind=server', async () => {
    const fetchFn = mockFetch(errResponse(503, 'upstream down'))
    const p = new OpenRouterProvider({ logicalProvider: 'gemini', apiKey: 'or', fetchFn })
    try {
      await p.query('hi')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      const pe = err as ProviderError
      expect(pe.status).toBe(503)
      expect(pe.kind).toBe('server')
      expect(pe.provider).toBe('gemini')
    }
  })

  it('passes AbortSignal to fetch', async () => {
    const fetchFn = mockFetch(okResponse(FAKE_RESPONSE_BODY))
    const p = new OpenRouterProvider({ logicalProvider: 'gemini', apiKey: 'or', fetchFn })
    const controller = new AbortController()
    await p.query('hi', { signal: controller.signal })
    const init = fetchFn.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBe(controller.signal)
  })
})
