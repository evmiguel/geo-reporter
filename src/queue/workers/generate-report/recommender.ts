import { z } from 'zod'
import type { Provider } from '../../../llm/providers/types.ts'
import { promptRecommender, type RecommenderInput } from '../../../llm/prompts.ts'
import type { NewRecommendation } from '../../../store/types.ts'

const RecommendationSchema = z.object({
  title: z.string().min(1).max(80),
  category: z.enum(['discoverability', 'recognition', 'accuracy', 'coverage', 'citation', 'seo']),
  impact: z.number().int().min(1).max(5),
  effort: z.number().int().min(1).max(5),
  rationale: z.string().min(1),
  how: z.string().min(1),
})

const MIN_RECS = 5

export interface RecommenderDeps {
  provider: Provider
}

export interface RunRecommenderInput extends RecommenderInput {
  gradeId: string
}

export interface RunRecommenderResult {
  recommendations: NewRecommendation[]
  attempts: number
  limited: boolean
}

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '').trim()
}

function parseAndValidate(text: string): z.infer<typeof RecommendationSchema>[] | null {
  try {
    const parsed = JSON.parse(stripCodeFences(text))
    if (!Array.isArray(parsed)) return null
    const result: z.infer<typeof RecommendationSchema>[] = []
    for (const item of parsed) {
      const v = RecommendationSchema.safeParse(item)
      if (!v.success) return null
      result.push(v.data)
    }
    return result
  } catch { return null }
}

function toRows(items: z.infer<typeof RecommendationSchema>[], gradeId: string): NewRecommendation[] {
  return items.map((r, i) => ({
    gradeId, rank: i + 1,
    title: r.title, category: r.category,
    impact: r.impact, effort: r.effort, rationale: r.rationale, how: r.how,
  }))
}

export async function runRecommender(
  deps: RecommenderDeps,
  input: RunRecommenderInput,
): Promise<RunRecommenderResult> {
  const prompt = promptRecommender(input)

  const first = await deps.provider.query(prompt)
  const parsed1 = parseAndValidate(first.text)
  if (parsed1 && parsed1.length >= MIN_RECS) {
    return { recommendations: toRows(parsed1, input.gradeId), attempts: 1, limited: false }
  }

  const stricter = `${prompt}\n\nReturn AT LEAST ${MIN_RECS} recommendations. The response MUST be valid JSON — an array of objects matching the schema above. No prose, no code fences, no explanation.`
  const second = await deps.provider.query(stricter)
  const parsed2 = parseAndValidate(second.text)
  if (parsed2 && parsed2.length >= MIN_RECS) {
    return { recommendations: toRows(parsed2, input.gradeId), attempts: 2, limited: false }
  }

  return { recommendations: [], attempts: 2, limited: true }
}
