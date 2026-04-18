import { evaluateSeo, SIGNAL_WEIGHT } from '../../../seo/index.ts'
import type { ScrapeResult } from '../../../scraper/index.ts'
import type { RunGradeDeps } from './deps.ts'
import { publishGradeEvent } from '../../events.ts'

export function collapseToCategoryScore(scores: (number | null)[]): number | null {
  const numeric = scores.filter((s): s is number => s !== null)
  if (numeric.length === 0) return null
  return Math.round(numeric.reduce((a, b) => a + b, 0) / numeric.length)
}

export interface CategoryArgs {
  gradeId: string
  scrape: ScrapeResult
  deps: RunGradeDeps
}

export async function runSeoCategory(args: CategoryArgs): Promise<number> {
  const { gradeId, scrape, deps } = args
  const result = evaluateSeo(scrape)

  for (const signal of result.signals) {
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.started', category: 'seo', provider: null, label: signal.name,
    })
    await deps.store.createProbe({
      gradeId, category: 'seo', provider: null,
      prompt: signal.name, response: signal.detail,
      score: signal.pass ? SIGNAL_WEIGHT * 10 : 0,
      metadata: { signal: signal.name, pass: signal.pass, weight: signal.weight },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category: 'seo', provider: null, label: signal.name,
      score: signal.pass ? SIGNAL_WEIGHT * 10 : 0, durationMs: 0, error: null,
    })
  }

  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'seo', score: result.score })
  return result.score
}
