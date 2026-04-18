import type { Provider, QueryOpts } from '../providers/types.ts'

export interface StaticProbeResult {
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  score: number | null
  scoreRationale: string | null
}

export interface RunStaticProbeInput {
  provider: Provider
  prompt: string
  scorer?: (response: string) => { score: number; rationale: string }
  signal?: AbortSignal
}

export async function runStaticProbe(input: RunStaticProbeInput): Promise<StaticProbeResult> {
  const { provider, prompt, scorer, signal } = input
  const opts: QueryOpts = {}
  if (signal !== undefined) opts.signal = signal
  const r = await provider.query(prompt, opts)
  const scored = scorer ? scorer(r.text) : null
  return {
    prompt,
    response: r.text,
    latencyMs: r.ms,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    score: scored?.score ?? null,
    scoreRationale: scored?.rationale ?? null,
  }
}
