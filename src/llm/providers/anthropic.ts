import { ProviderError, classifyStatus } from './errors.ts'
import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const ANTHROPIC_VERSION = '2023-06-01'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'

export interface AnthropicProviderOptions {
  apiKey: string
  model?: string
  fetchFn?: typeof globalThis.fetch
}

interface AnthropicResponse {
  content: { type: string; text: string }[]
  model: string
  usage: { input_tokens: number; output_tokens: number }
}

export class AnthropicProvider implements Provider {
  readonly id: ProviderId = 'claude'
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    const start = Date.now()
    const body = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      messages: [{ role: 'user', content: prompt }],
    }

    let res: Response
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      }
      if (opts.signal !== undefined) init.signal = opts.signal
      res = await this.fetchFn(ENDPOINT, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError('claude', null, 'network', `anthropic network error: ${message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError('claude', res.status, classifyStatus(res.status), `anthropic ${res.status}: ${text}`)
    }

    const data = (await res.json()) as AnthropicResponse
    const textBlock = data.content.find((b) => b.type === 'text')
    return {
      text: textBlock?.text ?? '',
      ms: Date.now() - start,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    }
  }
}
