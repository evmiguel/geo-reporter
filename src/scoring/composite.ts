import { toLetterGrade } from './letter.ts'
import type { CategoryId } from './weights.ts'

export type CategoryScores = Partial<Record<CategoryId, number | null>>

export interface OverallScore {
  overall: number
  letter: string
  usedWeights: Record<CategoryId, number>
  droppedCategories: CategoryId[]
}

export function weightedOverall(
  scores: CategoryScores,
  weights: Record<CategoryId, number>,
): OverallScore {
  const all = Object.keys(weights) as CategoryId[]
  const scored: CategoryId[] = []
  const dropped: CategoryId[] = []
  for (const c of all) {
    const v = scores[c]
    if (typeof v === 'number' && Number.isFinite(v)) scored.push(c)
    else dropped.push(c)
  }

  const totalScoredWeight = scored.reduce((s, c) => s + weights[c], 0)
  const weightedSum = scored.reduce((s, c) => s + (scores[c] as number) * weights[c], 0)
  const overall = totalScoredWeight === 0 ? 0 : Math.round(weightedSum / totalScoredWeight)

  const usedWeights: Record<CategoryId, number> = {
    discoverability: 0, recognition: 0, accuracy: 0, coverage: 0, citation: 0, seo: 0,
  }
  if (totalScoredWeight > 0) {
    let distributed = 0
    scored.forEach((c, i) => {
      if (i === scored.length - 1) {
        usedWeights[c] = 100 - distributed
      } else {
        const pct = Math.round((weights[c] / totalScoredWeight) * 100)
        usedWeights[c] = pct
        distributed += pct
      }
    })
  }

  return {
    overall,
    letter: toLetterGrade(overall),
    usedWeights,
    droppedCategories: dropped,
  }
}
