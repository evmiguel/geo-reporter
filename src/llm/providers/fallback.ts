import type { Provider, QueryResult, QueryOpts, ProviderId } from './types.ts'
import { ProviderError, type ProviderErrorKind } from './errors.ts'

const TRANSIENT_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'network', 'server', 'rate_limit', 'timeout', 'insufficient_credit',
])

export interface FallbackProviderOptions {
  primary: Provider
  secondary: Provider
}

/**
 * Wraps two providers. Calls primary first; on a transient error, retries with
 * secondary using the same prompt + opts. Propagates auth / 4xx-unknown errors
 * without retry (the secondary would fail for the same reason).
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
    } catch (err) {
      if (!isTransient(err)) throw err
      return this.opts.secondary.query(prompt, opts)
    }
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof ProviderError) return TRANSIENT_KINDS.has(err.kind)
  // Non-ProviderError throws (e.g. unexpected runtime errors) are treated as
  // transient — the secondary is a reasonable safety net.
  return true
}
