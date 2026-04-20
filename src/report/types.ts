import type { Grade } from '../store/types.ts'

export type CategoryId = 'discoverability' | 'recognition' | 'accuracy' | 'coverage' | 'citation' | 'seo'
export type ProviderId = 'claude' | 'gpt' | 'gemini' | 'perplexity' | 'mock'

export interface ScorecardCategory {
  id: CategoryId
  label: string
  weight: number
  score: number | null
  summary: string
}

export interface LlmAnswer {
  providerId: ProviderId
  providerLabel: string
  modelId: string
  modelLabel: string
  response: string
  score: number | null
}

export interface ProbeGroup {
  category: CategoryId
  question: string
  answers: LlmAnswer[]
}

export interface AccuracyRow {
  providerId: ProviderId
  providerLabel: string
  answer: string
  ruling: 'correct' | 'partial' | 'wrong' | 'unknown'
  rationale: string | null
}

export interface AccuracyProbe {
  question: string
  truth: string
  rows: AccuracyRow[]
  summary: string
}

export interface SeoSignal {
  label: string
  pass: boolean
  detail: string
}

export interface RecommendationCard {
  rank: number
  category: string
  title: string
  impact: number
  effort: number
  priority: number
  rationale: string
  how: string
}

export interface ModelSnapshot {
  providerId: ProviderId
  modelId: string
}

export interface ReportInput {
  generatedAt: Date
  grade: Pick<Grade, 'id' | 'url' | 'domain' | 'overall' | 'letter' | 'scores' | 'createdAt'>
  reportId: string
  scorecard: ScorecardCategory[]
  rawResponsesByProbe: ProbeGroup[]
  accuracyProbes: AccuracyProbe[]
  seoFindings: SeoSignal[]
  recommendations: RecommendationCard[]
  models: ModelSnapshot[]
}
