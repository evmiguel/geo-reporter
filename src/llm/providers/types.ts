export type ProviderId = 'claude' | 'gpt' | 'gemini' | 'perplexity' | 'mock'

export interface QueryResult {
  text: string
  ms: number
  inputTokens: number
  outputTokens: number
}

export interface QueryOpts {
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface Provider {
  readonly id: ProviderId
  readonly model: string
  query(prompt: string, opts?: QueryOpts): Promise<QueryResult>
}
