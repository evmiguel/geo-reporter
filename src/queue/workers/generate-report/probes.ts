import type Redis from 'ioredis'
import type { Provider } from '../../../llm/providers/types.ts'
import type { ScrapeResult } from '../../../scraper/index.ts'
import type { Grade, GradeStore } from '../../../store/types.ts'
import type { GradeEvent } from '../../events.ts'
import {
  runAccuracyCategory,
  runCitationCategory,
  runCoverageCategory,
  runDiscoverabilityCategory,
  runRecognitionCategory,
} from '../run-grade/categories.ts'
import type { RunGradeDeps } from '../run-grade/deps.ts'

export interface DeltaProbeDeps {
  store: GradeStore
  providers: {
    gemini: Provider
    perplexity: Provider
    claudeForJudge: Provider
    generator: Provider
    verifier: Provider
  }
  publishEvent: (ev: GradeEvent) => Promise<void>
}

export interface DeltaProbeInput {
  grade: Grade
  scrape: ScrapeResult
}

/**
 * Runs the paid-tier delta probes (Gemini + Perplexity) across the five LLM-backed
 * categories. Reuses the existing run-grade category runners and re-labels their
 * `probe.*` events as `report.probe.*` before handing them to `publishEvent`.
 * `category.completed` events are dropped — the delta run does not rescore
 * categories, it only adds rows for the two additional providers.
 */
export async function runDeltaProbes(
  deps: DeltaProbeDeps,
  input: DeltaProbeInput,
): Promise<void> {
  const { store, providers, publishEvent } = deps
  const { grade, scrape } = input
  const probers: Provider[] = [providers.gemini, providers.perplexity]

  // Adapter: category runners publish via `deps.redis.publish(channel, JSON.stringify(event))`.
  // We intercept that call, decode the event, rewrite `probe.*` → `report.probe.*`, and
  // forward to the caller-supplied publishEvent. Events that are not probe-level (e.g.
  // `category.completed`) are dropped, since the delta run does not rescore categories.
  const adaptedRedis = makeRewritingRedis(publishEvent)

  const runGradeDeps: RunGradeDeps = {
    store,
    redis: adaptedRedis,
    // Feature code below only touches `deps.store` and `deps.redis` — factories are unused.
    providers: {} as never,
    scrapeFn: async () => scrape,
  }

  const gradeId = grade.id

  await runRecognitionCategory({ gradeId, grade, scrape, probers, deps: runGradeDeps })
  await runCitationCategory({ gradeId, grade, scrape, probers, deps: runGradeDeps })
  await runDiscoverabilityCategory({ gradeId, grade, scrape, probers, deps: runGradeDeps })
  await runCoverageCategory({
    gradeId, grade, scrape, probers,
    judge: providers.claudeForJudge,
    deps: runGradeDeps,
  })
  await runAccuracyCategory({
    gradeId, grade, scrape, probers,
    generator: providers.generator,
    verifier: providers.verifier,
    deps: runGradeDeps,
  })
}

/**
 * Builds a Redis stub that only implements `publish`. Each call is decoded,
 * rewritten from `probe.*` → `report.probe.*`, and forwarded to `publishEvent`.
 * Non-probe events are silently dropped. All other Redis methods are absent;
 * calling them would throw, but the category runners only touch `publish`.
 */
function makeRewritingRedis(
  publishEvent: (ev: GradeEvent) => Promise<void>,
): Redis {
  const stub = {
    async publish(_channel: string, message: string): Promise<number> {
      let parsed: GradeEvent
      try {
        parsed = JSON.parse(message) as GradeEvent
      } catch {
        return 0
      }
      const rewritten = rewriteProbeEvent(parsed)
      if (rewritten) await publishEvent(rewritten)
      return 1
    },
  }
  return stub as unknown as Redis
}

/**
 * Translate a run-grade event into the paid-report event stream.
 * Returns null for events the delta run should not surface.
 */
function rewriteProbeEvent(ev: GradeEvent): GradeEvent | null {
  if (ev.type === 'probe.started') {
    // Delta probes never run with provider=null (that would be SEO, which we don't run here).
    if (ev.provider === null) return null
    return {
      type: 'report.probe.started',
      category: ev.category,
      provider: ev.provider,
      label: ev.label,
    }
  }
  if (ev.type === 'probe.completed') {
    if (ev.provider === null) return null
    return {
      type: 'report.probe.completed',
      category: ev.category,
      provider: ev.provider,
      label: ev.label,
      score: ev.score,
      durationMs: ev.durationMs,
      error: ev.error,
    }
  }
  // category.completed and any other event types are not re-emitted in the delta run.
  return null
}
