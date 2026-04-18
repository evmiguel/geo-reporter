import { generateQuestion } from './generator.ts'
import { verifyAnswer } from './verifier.ts'
import { toGroundTruth } from '../llm/ground-truth.ts'
import type { GeneratedQuestion } from './generator.ts'
import type { ProbeAnswer, VerificationResult } from './verifier.ts'
import type { ScrapeResult } from '../scraper/index.ts'
import type { Provider, QueryOpts } from '../llm/providers/types.ts'

export type { GeneratedQuestion } from './generator.ts'
export type { ProbeAnswer, VerificationResult } from './verifier.ts'
export { generateQuestion } from './generator.ts'
export { verifyAnswer } from './verifier.ts'

export type AccuracyReason = 'ok' | 'insufficient_scrape' | 'all_null' | 'all_failed'

export interface AccuracyResult {
  score: number | null
  reason: AccuracyReason
  generator: GeneratedQuestion | null
  probes: ProbeAnswer[]
  verifications: VerificationResult[]
  valid: number
  correct: number
}

export interface RunAccuracyInput {
  generator: Provider
  verifier: Provider
  probers: Provider[]
  url: string
  scrape: ScrapeResult
  signal?: AbortSignal
}

const SCRAPE_MIN_CHARS = 500

export async function runAccuracy(input: RunAccuracyInput): Promise<AccuracyResult> {
  const { generator, verifier, probers, url, scrape, signal } = input

  if (scrape.text.length < SCRAPE_MIN_CHARS) {
    return {
      score: null,
      reason: 'insufficient_scrape',
      generator: null,
      probes: [],
      verifications: [],
      valid: 0,
      correct: 0,
    }
  }

  const gt = toGroundTruth(url, scrape)

  const genInput = signal !== undefined
    ? { generator, groundTruth: gt, signal }
    : { generator, groundTruth: gt }
  const gen = await generateQuestion(genInput)

  const probeOpts: QueryOpts = { temperature: 0.7 }
  if (signal !== undefined) probeOpts.signal = signal

  const probes: ProbeAnswer[] = await Promise.all(
    probers.map(async (p): Promise<ProbeAnswer> => {
      try {
        const r = await p.query(gen.question, probeOpts)
        return {
          providerId: p.id,
          answer: r.text,
          latencyMs: r.ms,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          error: null,
        }
      } catch (err) {
        return {
          providerId: p.id,
          answer: '',
          latencyMs: 0, inputTokens: 0, outputTokens: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  const verifiable = probes.filter((p) => p.answer !== '' && p.error === null)
  const verifications: VerificationResult[] = await Promise.all(
    verifiable.map((p) => verifyAnswer({
      verifier, groundTruth: gt, question: gen.question, probeAnswer: p,
      ...(signal !== undefined ? { signal } : {}),
    })),
  )

  const valid = verifications.filter((v) => v.correct !== null).length
  const correct = verifications.filter((v) => v.correct === true).length

  let reason: AccuracyReason
  let score: number | null
  if (verifications.length === 0) {
    reason = 'all_failed'
    score = null
  } else if (valid === 0) {
    reason = 'all_null'
    score = null
  } else {
    reason = 'ok'
    score = Math.round((correct / valid) * 100)
  }

  return { score, reason, generator: gen, probes, verifications, valid, correct }
}
