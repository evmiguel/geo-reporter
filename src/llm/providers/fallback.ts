import type { Provider, QueryResult, QueryOpts, ProviderId } from './types.ts'

export interface FallbackProviderOptions {
  primary: Provider
  secondary: Provider
}

/**
 * Wraps two providers. Calls primary first; on ANY error, retries with
 * secondary using the same prompt + opts.
 *
 * Previously we only retried "transient" errors (5xx/429/network/timeout/
 * insufficient_credit) on the assumption that a 4xx would fail the same way
 * on secondary. That assumption is wrong in our setup: secondary is
 * OpenRouter with fully independent credentials and a different error
 * profile, so Gemini/OpenAI-specific 400/401/403 errors often succeed
 * through OpenRouter. Retrying everything minimizes user-visible probe
 * failures; if secondary also fails, that error propagates normally.
 */
export class FallbackProvider implements Provider {
  readonly id: ProviderId

  constructor(private readonly opts: FallbackProviderOptions) {
    this.id = opts.primary.id
  }

  get model(): string {
    return this.opts.primary.model
  }

  async query(prompt: string, opts: QueryOpts = {}): Promise<QueryResult> {
    try {
      return await this.opts.primary.query(prompt, opts)
    } catch {
      return this.opts.secondary.query(prompt, opts)
    }
  }
}
