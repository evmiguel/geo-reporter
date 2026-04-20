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
  | { type: 'failed'; kind: 'provider_outage' | 'other'; error: string }
  // Plan 8 — paid-report pipeline
  | { type: 'report.started' }
  | { type: 'report.probe.started'; category: CategoryId; provider: ProviderId; label: string }
  | {
      type: 'report.probe.completed'
      category: CategoryId
      provider: ProviderId
      label: string
      score: number | null
      durationMs: number
      error: string | null
    }
  | { type: 'report.recommendations.started' }
  | { type: 'report.recommendations.completed'; count: number }
  | { type: 'report.done'; reportId: string; token: string }
  | { type: 'report.failed'; error: string }

// Client-only actions dispatched outside the SSE stream (e.g. rehydrating
// paid-report state from `GET /grades/:id` on page refresh).
export type GradeAction =
  | GradeEvent
  | { type: 'hydrate_paid'; reportId: string; reportToken: string }
  | { type: 'hydrate_generating' }

export type PaidStatus = 'none' | 'checking_out' | 'generating' | 'ready' | 'failed'

/**
 * Sub-phase within paidStatus='generating'. Drives ReportProgress so users
 * see the pipeline move past "Running blind probes" once the worker starts
 * on recommendations / rendering. null when no paid report is in flight.
 */
export type ReportPhase = 'probing' | 'writing' | 'rendering' | null

export type PdfStatus = 'pending' | 'ready' | 'failed'
export interface ReportStatusResponse {
  html: 'ready'
  pdf: PdfStatus
}

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
  failedKind: 'provider_outage' | 'other' | null
  paidStatus: PaidStatus
  reportPhase: ReportPhase
  reportId: string | null
  reportToken: string | null
  reportProbeCount: number
}

export const CATEGORY_ORDER: CategoryId[] = [
  'discoverability', 'recognition', 'accuracy', 'coverage', 'citation', 'seo',
]

export const CATEGORY_WEIGHTS: Record<CategoryId, number> = {
  discoverability: 30, recognition: 20, accuracy: 20, coverage: 10, citation: 10, seo: 10,
}
