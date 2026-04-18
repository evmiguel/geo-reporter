import { ProviderError, classifyStatus } from './errors.ts'
import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface GeminiProviderOptions {
  apiKey: string
  model?: string
  fetchFn?: typeof globalThis.fetch
}

interface GeminiResponse {
  candidates: { content: { parts: { text: string }[] } }[]
  usageMetadata: { promptTokenCount: number; candidatesTokenCount: number }
}

export class GeminiProvider implements Provider {
  readonly id: ProviderId = 'gemini'
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(opts: GeminiProviderOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    const start = Date.now()
    const url = `${BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.7,
      },
    }

    let res: Response
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
      if (opts.signal !== undefined) init.signal = opts.signal
      res = await this.fetchFn(url, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError('gemini', null, 'network', `gemini network error: ${message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError('gemini', res.status, classifyStatus(res.status), `gemini ${res.status}: ${text}`)
    }

    const data = (await res.json()) as GeminiResponse
    const parts = data.candidates[0]?.content.parts ?? []
    return {
      text: parts.map((p) => p.text).join(''),
      ms: Date.now() - start,
      inputTokens: data.usageMetadata.promptTokenCount,
      outputTokens: data.usageMetadata.candidatesTokenCount,
    }
  }
}
