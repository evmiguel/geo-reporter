import type { Provider, ProviderId, QueryOpts, QueryResult } from './types.ts'

export type MockResponses = Record<string, string> | ((prompt: string) => string)

export interface MockProviderOptions {
  id: ProviderId
  responses: MockResponses
  failWith?: string
  latencyMs?: number
}

export interface MockCall {
  prompt: string
  opts: QueryOpts
}

export class MockProvider implements Provider {
  readonly id: ProviderId
  readonly calls: MockCall[] = []
  private readonly responses: MockResponses
  private readonly failWith: string | undefined
  private readonly latencyMs: number

  constructor(opts: MockProviderOptions) {
    this.id = opts.id
    this.responses = opts.responses
    this.failWith = opts.failWith
    this.latencyMs = opts.latencyMs ?? 0
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    this.calls.push({ prompt, opts })

    if (this.failWith) throw new Error(this.failWith)

    if (opts.signal?.aborted) throw new Error('aborted')

    let text: string | undefined
    if (typeof this.responses === 'function') {
      text = this.responses(prompt)
    } else {
      text = this.responses[prompt]
    }

    if (text === undefined) {
      throw new Error(`MockProvider(${this.id}): no match for prompt: ${prompt}`)
    }

    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.latencyMs)
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        })
      })
    }

    return {
      text,
      ms: this.latencyMs,
      inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      outputTokens: Math.max(1, Math.ceil(text.length / 4)),
    }
  }
}
