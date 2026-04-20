import { ProviderError, classifyStatus } from './errors.ts'
import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

const DEFAULT_MODEL = 'sonar'
const ENDPOINT = 'https://api.perplexity.ai/chat/completions'

export interface PerplexityProviderOptions {
  apiKey: string
  model?: string
  fetchFn?: typeof globalThis.fetch
}

interface PerplexityResponse {
  choices: { message: { content: string } }[]
  usage: { prompt_tokens: number; completion_tokens: number }
}

export class PerplexityProvider implements Provider {
  readonly id: ProviderId = 'perplexity'
  readonly model: string
  private readonly apiKey: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(opts: PerplexityProviderOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    const start = Date.now()
    const body = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
    }

    let res: Response
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      }
      if (opts.signal !== undefined) init.signal = opts.signal
      res = await this.fetchFn(ENDPOINT, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError('perplexity', null, 'network', `perplexity network error: ${message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError('perplexity', res.status, classifyStatus(res.status), `perplexity ${res.status}: ${text}`)
    }

    const data = (await res.json()) as PerplexityResponse
    return {
      text: data.choices[0]?.message.content ?? '',
      ms: Date.now() - start,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    }
  }
}
