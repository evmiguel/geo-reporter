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
  readonly calls: ReadonlyArray<MockCall>
  private readonly _calls: MockCall[] = []
  private readonly responses: MockResponses
  private readonly failWith: string | undefined
  private readonly latencyMs: number

  constructor(opts: MockProviderOptions) {
    this.id = opts.id
    this.calls = this._calls
    this.responses = opts.responses
    this.failWith = opts.failWith
    this.latencyMs = opts.latencyMs ?? 0
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    this._calls.push({ prompt, opts })

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
      const signal = opts.signal
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(t)
          reject(new Error('aborted'))
        }
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, this.latencyMs)
        signal?.addEventListener('abort', onAbort, { once: true })
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
