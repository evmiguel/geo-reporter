import { promptCoverage } from '../prompts.ts'
import { runJudge } from '../judge.ts'
import type { GroundTruth, ProbeForJudge } from '../ground-truth.ts'
import type { JudgeResult } from '../judge.ts'
import type { Provider, ProviderId, QueryOpts } from '../providers/types.ts'

export interface CoverageProbe {
  provider: ProviderId
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  error: string | null
}

export interface CoverageFlowResult {
  probes: CoverageProbe[]
  judge: JudgeResult
}

export interface RunCoverageFlowInput {
  providers: Provider[]
  judge: Provider
  groundTruth: GroundTruth
  signal?: AbortSignal
}

export async function runCoverageFlow(input: RunCoverageFlowInput): Promise<CoverageFlowResult> {
  const { providers, judge, groundTruth, signal } = input
  const opts: QueryOpts = {}
  if (signal !== undefined) opts.signal = signal
  const prompts = promptCoverage(groundTruth.domain)

  const tasks: Promise<CoverageProbe>[] = []
  for (const p of providers) {
    for (const prompt of prompts) {
      tasks.push((async (): Promise<CoverageProbe> => {
        try {
          const r = await p.query(prompt, opts)
          return {
            provider: p.id,
            prompt,
            response: r.text,
            latencyMs: r.ms,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            error: null,
          }
        } catch (err) {
          return {
            provider: p.id,
            prompt,
            response: '',
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      })())
    }
  }
  const probes = await Promise.all(tasks)

  const forJudge: ProbeForJudge[] = probes
    .filter((p) => p.response !== '' && p.error === null)
    .map((p, i) => ({
      key: `probe_${i + 1}`,
      provider: p.provider,
      category: 'coverage' as const,
      prompt: p.prompt,
      response: p.response,
    }))

  if (forJudge.length === 0) {
    return {
      probes,
      judge: {
        prompt: '',
        rawResponse: '',
        perProbe: new Map(),
        perProvider: {},
        degraded: true,
      },
    }
  }

  const judgeResult = await runJudge({ judge, groundTruth, probes: forJudge, ...(signal !== undefined ? { signal } : {}) })
  return { probes, judge: judgeResult }
}
