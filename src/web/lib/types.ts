export type CategoryId =
  | 'discoverability' | 'recognition' | 'accuracy' | 'coverage' | 'citation' | 'seo'

export type ProviderId = 'claude' | 'gpt' | 'gemini' | 'perplexity' | 'mock'

export type GradeEvent =
  | { type: 'running' }
  | { type: 'scraped'; rendered: boolean; textLength: number }
  | { type: 'probe.started'; category: CategoryId; provider: ProviderId | null; label: string }
  | {
      type: 'probe.completed'
      category: CategoryId
      provider: ProviderId | null
      label: string
      score: number | null
      durationMs: number
      error: string | null
    }
  | { type: 'category.completed'; category: CategoryId; score: number | null }
  | { type: 'done'; overall: number; letter: string; scores: Record<CategoryId, number | null> }
  | { type: 'failed'; error: string }

export type Phase = 'queued' | 'running' | 'scraped' | 'done' | 'failed'

export interface ProbeEntry {
  key: string
  category: CategoryId
  provider: ProviderId | null
  label: string
  status: 'started' | 'completed'
  score: number | null
  durationMs: number
  error: string | null
  startedAt: number
}

export interface GradeState {
  phase: Phase
  scraped: { rendered: boolean; textLength: number } | null
  probes: Map<string, ProbeEntry>
  categoryScores: Record<CategoryId, number | null>
  overall: number | null
  letter: string | null
  error: string | null
}

export const CATEGORY_ORDER: CategoryId[] = [
  'discoverability', 'recognition', 'accuracy', 'coverage', 'citation', 'seo',
]

export const CATEGORY_WEIGHTS: Record<CategoryId, number> = {
  discoverability: 30, recognition: 20, accuracy: 20, coverage: 10, citation: 10, seo: 10,
}
