import type { ProviderId } from './types.ts'

export type ProviderErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'server'
  | 'timeout'
  | 'network'
  | 'insufficient_credit'
  | 'unknown'

const MAX_MESSAGE_LEN = 200

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number | null,
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    const truncated = message.length > MAX_MESSAGE_LEN
      ? message.slice(0, MAX_MESSAGE_LEN) + '…[truncated]'
      : message
    super(truncated)
    this.name = 'ProviderError'
  }
}

export function classifyStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500 && status < 600) return 'server'
  if (status >= 400 && status < 500) return 'unknown'
  return 'unknown'
}
