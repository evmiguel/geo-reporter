import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../../../../src/llm/providers/anthropic.ts'
import { ProviderError } from '../../../../src/llm/providers/errors.ts'

function mockFetch(status: number, body: unknown) {
  return async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

const OK_BODY = {
  content: [{ type: 'text', text: 'hello world' }],
  model: 'claude-sonnet-4-6',
  usage: { input_tokens: 10, output_tokens: 5 },
}

describe('AnthropicProvider', () => {
  it('sends POST with x-api-key + anthropic-version headers', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      fetchFn: async (url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return new Response(JSON.stringify(OK_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    await p.query('hi')
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    expect(capturedInit?.method).toBe('POST')
  })

  it('parses text + token counts from response', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(200, OK_BODY) })
    const r = await p.query('hi')
    expect(r.text).toBe('hello world')
    expect(r.inputTokens).toBe(10)
    expect(r.outputTokens).toBe(5)
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  it('sends temperature 0.7 + maxTokens 2048 by default', async () => {
    let body: unknown
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi')
    expect(body).toMatchObject({ temperature: 0.7, max_tokens: 2048 })
  })

  it('forwards temperature + maxTokens opts', async () => {
    let body: unknown
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    await p.query('hi', { temperature: 0, maxTokens: 500 })
    expect(body).toMatchObject({ temperature: 0, max_tokens: 500 })
  })

  it('throws ProviderError(rate_limit) on 429', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(429, { error: 'rate' }) })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'rate_limit', status: 429, provider: 'claude' })
    await expect(p.query('hi')).rejects.toBeInstanceOf(ProviderError)
  })

  it('throws ProviderError(auth) on 401', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(401, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('throws ProviderError(server) on 500', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(500, '') })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'server', status: 500 })
  })

  it('classifies 400 credit-balance as insufficient_credit (fallback recoverable)', async () => {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }
    const p = new AnthropicProvider({ apiKey: 'k', fetchFn: mockFetch(400, body) })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'insufficient_credit', status: 400, provider: 'claude' })
  })

  it('also matches "insufficient" wording in 400 body', async () => {
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: mockFetch(400, { error: { message: 'insufficient funds' } }),
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'insufficient_credit', status: 400 })
  })

  it('leaves other 400s classified as unknown (not all 400s are recoverable)', async () => {
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: mockFetch(400, { error: { message: 'invalid model name' } }),
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'unknown', status: 400 })
  })

  it('throws ProviderError(network) on fetch throwing', async () => {
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: async () => { throw new TypeError('failed to fetch') },
    })
    await expect(p.query('hi')).rejects.toMatchObject({ kind: 'network', status: null, provider: 'claude' })
  })

  it('forwards AbortSignal to fetch', async () => {
    let capturedSignal: AbortSignal | undefined
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: async (_url, init) => {
        capturedSignal = init?.signal ?? undefined
        return new Response(JSON.stringify(OK_BODY), { status: 200 })
      },
    })
    const ctrl = new AbortController()
    await p.query('hi', { signal: ctrl.signal })
    expect(capturedSignal).toBe(ctrl.signal)
  })
})
