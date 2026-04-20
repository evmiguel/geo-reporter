import type { Provider, QueryResult, QueryOpts, ProviderId } from './types.ts'
import { ProviderError, classifyStatus } from './errors.ts'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

type OpenRouterLogicalProvider = Exclude<ProviderId, 'perplexity' | 'mock'>

const OR_MODELS: Record<OpenRouterLogicalProvider, string> = {
  claude: 'anthropic/claude-sonnet-4.5',
  gpt: 'openai/gpt-4o',
  gemini: 'google/gemini-2.5-pro',
}

export interface OpenRouterProviderOptions {
  logicalProvider: OpenRouterLogicalProvider
  apiKey: string
  model?: string
  fetchFn?: typeof globalThis.fetch
}

interface OpenRouterResponse {
  choices: { message: { content: string } }[]
  usage: { prompt_tokens: number; completion_tokens: number }
  model: string
}

export class OpenRouterProvider implements Provider {
  readonly id: ProviderId
  readonly model: string
  private readonly apiKey: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(opts: OpenRouterProviderOptions) {
    this.id = opts.logicalProvider
    this.model = opts.model ?? OR_MODELS[opts.logicalProvider]
    this.apiKey = opts.apiKey
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
      res = await this.fetchFn(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.apiKey}`,
          'x-title': 'geo-reporter',
        },
        body: JSON.stringify(body),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
    } catch (err) {
      throw new ProviderError(
        this.id, null, 'network',
        `openrouter network error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new ProviderError(
        this.id, res.status, classifyStatus(res.status),
        `openrouter ${res.status} ${res.statusText}: ${errBody.slice(0, 500)}`,
      )
    }

    const data = (await res.json()) as OpenRouterResponse
    const text = data.choices[0]?.message.content ?? ''

    return {
      text,
      ms: Date.now() - start,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    }
  }
}
