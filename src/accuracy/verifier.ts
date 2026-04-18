import { promptAccuracyVerifier } from '../llm/prompts.ts'
import type { GroundTruth } from '../llm/ground-truth.ts'
import type { Provider, ProviderId, QueryOpts } from '../llm/providers/types.ts'

export interface ProbeAnswer {
  providerId: ProviderId
  answer: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  error: string | null
}

export interface VerificationResult {
  providerId: ProviderId
  correct: boolean | null
  confidence: number
  rationale: string
  prompt: string
  rawResponse: string
  degraded: boolean
}

export interface VerifyAnswerInput {
  verifier: Provider
  groundTruth: GroundTruth
  question: string
  probeAnswer: ProbeAnswer
  signal?: AbortSignal
}

export async function verifyAnswer(input: VerifyAnswerInput): Promise<VerificationResult> {
  const { verifier, groundTruth, question, probeAnswer, signal } = input
  const prompt = promptAccuracyVerifier({
    gt: groundTruth,
    question,
    providerId: probeAnswer.providerId,
    answer: probeAnswer.answer,
  })
  const opts: QueryOpts = { temperature: 0 }
  if (signal !== undefined) opts.signal = signal

  let response = await verifier.query(prompt, opts)
  let parsed = tryParse(response.text)

  if (!parsed) {
    const stricter = `${prompt}\n\nIMPORTANT: Respond with ONLY a JSON object, no prose, no code fences.`
    response = await verifier.query(stricter, opts)
    parsed = tryParse(response.text)
  }

  if (!parsed) {
    return {
      providerId: probeAnswer.providerId,
      correct: null,
      confidence: 0,
      rationale: 'verifier parse failed',
      prompt,
      rawResponse: response.text,
      degraded: true,
    }
  }

  return {
    providerId: probeAnswer.providerId,
    correct: parsed.correct,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    prompt,
    rawResponse: response.text,
    degraded: false,
  }
}

interface Parsed { correct: boolean | null; confidence: number; rationale: string }

function tryParse(text: string): Parsed | null {
  const candidates: string[] = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1])
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s !== -1 && e > s) candidates.push(text.slice(s, e + 1))

  for (const c of candidates) {
    try {
      const raw = JSON.parse(c.trim())
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const correct = r['correct']
      const confidence = r['confidence']
      const rationale = r['rationale']
      if (correct !== true && correct !== false && correct !== null) continue
      if (typeof confidence !== 'number') continue
      if (typeof rationale !== 'string') continue
      return { correct, confidence, rationale }
    } catch { /* try next */ }
  }
  return null
}
