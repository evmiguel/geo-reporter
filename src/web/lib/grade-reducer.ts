import type { GradeAction, GradeState, CategoryId, ProbeEntry } from './types.ts'

export function initialGradeState(): GradeState {
  return {
    phase: 'queued',
    scraped: null,
    probes: new Map(),
    categoryScores: {
      discoverability: null, recognition: null, accuracy: null,
      coverage: null, citation: null, seo: null,
    },
    overall: null,
    letter: null,
    error: null,
    failedKind: null,
    paidStatus: 'none',
    reportPhase: null,
    reportId: null,
    reportToken: null,
    reportProbeCount: 0,
  }
}

function probeKey(category: CategoryId, provider: string | null, label: string): string {
  return `${category}:${provider ?? '-'}:${label}`
}

export function reduceGradeEvents(state: GradeState, event: GradeAction, now: number): GradeState {
  switch (event.type) {
    case 'running':
      return { ...state, phase: 'running' }
    case 'scraped':
      return { ...state, phase: 'scraped', scraped: { rendered: event.rendered, textLength: event.textLength } }
    case 'probe.started': {
      const key = probeKey(event.category, event.provider, event.label)
      const probes = new Map(state.probes)
      const existing = probes.get(key)
      probes.set(key, {
        key,
        category: event.category,
        provider: event.provider,
        label: event.label,
        status: 'started',
        score: null,
        durationMs: 0,
        error: null,
        startedAt: existing?.startedAt ?? now,
      })
      return { ...state, probes }
    }
    case 'probe.completed': {
      const key = probeKey(event.category, event.provider, event.label)
      const probes = new Map(state.probes)
      const existing = probes.get(key)
      probes.set(key, {
        key,
        category: event.category,
        provider: event.provider,
        label: event.label,
        status: 'completed',
        score: event.score,
        durationMs: event.durationMs,
        error: event.error,
        startedAt: existing?.startedAt ?? now,
      })
      return { ...state, probes }
    }
    case 'category.completed':
      return {
        ...state,
        categoryScores: { ...state.categoryScores, [event.category]: event.score },
      }
    case 'done':
      return {
        ...state,
        phase: 'done',
        overall: event.overall,
        letter: event.letter,
        categoryScores: event.scores,
      }
    case 'failed':
      return { ...state, phase: 'failed', error: event.error, failedKind: event.kind }
    case 'report.started':
      return { ...state, paidStatus: 'generating', reportPhase: 'probing', reportProbeCount: 0 }
    case 'report.probe.started': {
      const key = probeKey(event.category, event.provider, event.label)
      const existing = state.probes.get(key)
      const entry: ProbeEntry = {
        key,
        category: event.category,
        provider: event.provider,
        label: event.label,
        status: 'started',
        score: null,
        durationMs: 0,
        error: null,
        startedAt: existing?.startedAt ?? now,
      }
      const probes = new Map(state.probes)
      probes.set(key, entry)
      return { ...state, probes }
    }
    case 'report.probe.completed': {
      const key = probeKey(event.category, event.provider, event.label)
      const existing = state.probes.get(key)
      const entry: ProbeEntry = {
        key,
        category: event.category,
        provider: event.provider,
        label: event.label,
        status: 'completed',
        score: event.score,
        durationMs: event.durationMs,
        error: event.error,
        startedAt: existing?.startedAt ?? now,
      }
      const probes = new Map(state.probes)
      probes.set(key, entry)
      return { ...state, probes, reportProbeCount: state.reportProbeCount + 1 }
    }
    case 'report.recommendations.started':
      return { ...state, reportPhase: 'writing' }
    case 'report.recommendations.completed':
      return { ...state, reportPhase: 'rendering' }
    case 'report.done':
      return {
        ...state, paidStatus: 'ready', reportPhase: null,
        reportId: event.reportId, reportToken: event.token,
      }
    case 'report.failed':
      return { ...state, paidStatus: 'failed', reportPhase: null, error: event.error }
    case 'hydrate_paid':
      return {
        ...state, paidStatus: 'ready', reportPhase: null,
        reportId: event.reportId, reportToken: event.reportToken,
      }
    case 'hydrate_generating':
      // Only hydrate into 'generating' if nothing live has arrived yet — if the
      // reducer already saw 'report.done' or 'report.failed' via SSE, keep that.
      // We default the sub-phase to 'probing' since the server-side payload
      // doesn't tell us where in the pipeline the worker currently is; SSE
      // events will push us forward as they arrive.
      if (state.paidStatus === 'ready' || state.paidStatus === 'failed') return state
      return { ...state, paidStatus: 'generating', reportPhase: 'probing' }
  }
}
