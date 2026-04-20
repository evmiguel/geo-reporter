import { describe, it, expect, vi } from 'vitest'
import { FallbackProvider } from '../../../../src/llm/providers/fallback.ts'
import { ProviderError } from '../../../../src/llm/providers/errors.ts'
import type { Provider, QueryResult } from '../../../../src/llm/providers/types.ts'

function stubProvider(id: 'claude' | 'gpt' | 'gemini', impl: (prompt: string) => Promise<QueryResult>): Provider {
  return { id, model: `stub:${id}`, query: vi.fn().mockImplementation(impl) }
}

function ok(text: string, markerTokens = 10): QueryResult {
  return { text, ms: 5, inputTokens: markerTokens, outputTokens: markerTokens }
}

describe('FallbackProvider', () => {
  it('returns primary result on success, does not call secondary', async () => {
    const primary = stubProvider('gemini', async () => ok('primary'))
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hello')
    expect(result.text).toBe('primary')
    expect(secondary.query).not.toHaveBeenCalled()
  })

  it('exposes primary.id as its own id', () => {
    const primary = stubProvider('gemini', async () => ok('x'))
    const secondary = stubProvider('gemini', async () => ok('x'))
    const fp = new FallbackProvider({ primary, secondary })
    expect(fp.id).toBe('gemini')
  })

  it('falls back on server (5xx) error', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', 503, 'server', 'primary down')
    })
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('secondary')
    expect(secondary.query).toHaveBeenCalledTimes(1)
  })

  it('falls back on rate_limit (429)', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', 429, 'rate_limit', 'too many requests')
    })
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('secondary')
  })

  it('falls back on network error', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', null, 'network', 'ECONNREFUSED')
    })
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('secondary')
  })

  it('falls back on insufficient_credit (primary account out of funds)', async () => {
    const primary = stubProvider('claude', async () => {
      throw new ProviderError('claude', 400, 'insufficient_credit', 'anthropic 400: credit balance too low')
    })
    const secondary = stubProvider('claude', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('secondary')
    expect(secondary.query).toHaveBeenCalledTimes(1)
  })

  it('falls back on timeout', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', 504, 'timeout', 'gateway timeout')
    })
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('secondary')
  })

  it('falls back on non-ProviderError throw', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new Error('something weird happened')
    })
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('secondary')
  })

  it('falls back on auth error (401/403) — secondary has independent credentials', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', 401, 'auth', 'invalid api key')
    })
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('secondary')
    expect(secondary.query).toHaveBeenCalledTimes(1)
  })

  it('falls back on 400-class unknown errors (quota, API-not-enabled, etc.)', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', 400, 'unknown', 'quota exceeded')
    })
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('secondary')
    expect(secondary.query).toHaveBeenCalledTimes(1)
  })

  it('falls back on 403 Gemini "API not enabled for region" style errors', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', 403, 'auth', 'API not enabled')
    })
    const secondary = stubProvider('gemini', async () => ok('via openrouter'))
    const fp = new FallbackProvider({ primary, secondary })
    const result = await fp.query('hi')
    expect(result.text).toBe('via openrouter')
  })

  it('re-throws secondary error if secondary also fails', async () => {
    const primary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', 503, 'server', 'primary down')
    })
    const secondary = stubProvider('gemini', async () => {
      throw new ProviderError('gemini', 503, 'server', 'secondary also down')
    })
    const fp = new FallbackProvider({ primary, secondary })
    await expect(fp.query('hi')).rejects.toThrow(/secondary also down/)
  })

  it('passes prompt + opts through to the provider that handles the call', async () => {
    const primary = stubProvider('gemini', async (prompt) => ok(prompt.toUpperCase()))
    const secondary = stubProvider('gemini', async () => ok('secondary'))
    const fp = new FallbackProvider({ primary, secondary })
    const controller = new AbortController()
    const result = await fp.query('hello', { maxTokens: 100, signal: controller.signal })
    expect(result.text).toBe('HELLO')
    const call = (primary.query as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[0]).toBe('hello')
    expect(call[1]).toMatchObject({ maxTokens: 100 })
    expect(call[1]?.signal).toBe(controller.signal)
  })
})
