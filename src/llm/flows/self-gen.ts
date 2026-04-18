import { promptDiscoverabilityGenerator } from '../prompts.ts'
import type { GroundTruth } from '../ground-truth.ts'
import type { Provider, QueryOpts } from '../providers/types.ts'
import { brandFromDomain } from '../../scoring/discoverability.ts'

export interface SelfGenStage {
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export interface SelfGenProbeResult {
  generator: SelfGenStage
  probe: SelfGenStage
  score: number
  scoreRationale: string
}

export interface RunSelfGenProbeInput {
  provider: Provider
  groundTruth: GroundTruth
  scorer: (args: { text: string; brand: string; domain: string }) => number
  signal?: AbortSignal
}

export async function runSelfGenProbe(input: RunSelfGenProbeInput): Promise<SelfGenProbeResult> {
  const { provider, groundTruth, scorer, signal } = input
  const opts: QueryOpts = {}
  if (signal !== undefined) opts.signal = signal

  const stage1Prompt = promptDiscoverabilityGenerator(groundTruth)
  const stage1 = await provider.query(stage1Prompt, opts)
  const question = stage1.text.trim()

  const stage2 = await provider.query(question, opts)

  const brand = brandFromDomain(groundTruth.domain)
  const score = scorer({ text: stage2.text, brand, domain: groundTruth.domain })

  return {
    generator: {
      prompt: stage1Prompt,
      response: stage1.text,
      latencyMs: stage1.ms,
      inputTokens: stage1.inputTokens,
      outputTokens: stage1.outputTokens,
    },
    probe: {
      prompt: question,
      response: stage2.text,
      latencyMs: stage2.ms,
      inputTokens: stage2.inputTokens,
      outputTokens: stage2.outputTokens,
    },
    score,
    scoreRationale: `self-gen heuristic (brand=${brand})`,
  }
}
