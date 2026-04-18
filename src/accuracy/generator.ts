import { promptAccuracyGenerator } from '../llm/prompts.ts'
import type { GroundTruth } from '../llm/ground-truth.ts'
import type { Provider, QueryOpts } from '../llm/providers/types.ts'

export interface GeneratedQuestion {
  question: string
  prompt: string
  response: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export interface GenerateQuestionInput {
  generator: Provider
  groundTruth: GroundTruth
  signal?: AbortSignal
}

export async function generateQuestion(input: GenerateQuestionInput): Promise<GeneratedQuestion> {
  const { generator, groundTruth, signal } = input
  const prompt = promptAccuracyGenerator(groundTruth)
  const opts: QueryOpts = { temperature: 0.3 }
  if (signal !== undefined) opts.signal = signal
  const r = await generator.query(prompt, opts)
  const question = r.text.trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '').trim()
  return {
    question,
    prompt,
    response: r.text,
    latencyMs: r.ms,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  }
}
