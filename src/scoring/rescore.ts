import type { Probe } from '../store/types.ts'
import type { CategoryId } from './weights.ts'
import { DEFAULT_WEIGHTS } from './weights.ts'
import { weightedOverall, type CategoryScores } from './composite.ts'

export interface RescoreResult {
  overall: number
  letter: string
  scores: Record<CategoryId, number | null>
}

export function rescoreFromProbes(probes: Probe[]): RescoreResult {
  // Dedup: newest createdAt wins per (category, provider, label).
  const keyFor = (p: Probe): string => {
    const meta = p.metadata as { label?: string }
    const label = typeof meta.label === 'string' ? meta.label : p.category
    return `${p.category}:${p.provider ?? 'null'}:${label}`
  }
  const latest = new Map<string, Probe>()
  for (const p of probes) {
    const key = keyFor(p)
    const existing = latest.get(key)
    if (!existing || existing.createdAt.getTime() < p.createdAt.getTime()) {
      latest.set(key, p)
    }
  }

  const byCategory: Record<CategoryId, Probe[]> = {
    discoverability: [], recognition: [], accuracy: [], coverage: [], citation: [], seo: [],
  }
  for (const p of latest.values()) byCategory[p.category].push(p)

  const scores: Record<CategoryId, number | null> = {
    discoverability: null, recognition: null, accuracy: null,
    coverage: null, citation: null, seo: null,
  }
  for (const cat of Object.keys(byCategory) as CategoryId[]) {
    const rows = byCategory[cat].filter((p) => typeof p.score === 'number')
    if (rows.length === 0) continue
    const sum = rows.reduce((acc, p) => acc + (p.score as number), 0)
    scores[cat] = Math.round(sum / rows.length)
  }

  const categoryScores: CategoryScores = scores
  const { overall, letter } = weightedOverall(categoryScores, DEFAULT_WEIGHTS)
  return { overall, letter, scores }
}
