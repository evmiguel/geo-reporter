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

import { promptRecognition, promptCitation } from '../../../llm/prompts.ts'
import { runStaticProbe } from '../../../llm/flows/static-probe.ts'
import { scoreRecognition } from '../../../scoring/recognition.ts'
import { scoreCitation } from '../../../scoring/citation.ts'
import type { Provider } from '../../../llm/providers/types.ts'
import type { Grade } from '../../../store/types.ts'

// Widens CategoryArgs with grade + probers for prober-using adapters.
export interface ScrapedCategoryArgs extends CategoryArgs {
  grade: Grade
  probers: Provider[]
}

export async function runRecognitionCategory(args: ScrapedCategoryArgs): Promise<number | null> {
  const { gradeId, grade, probers, deps } = args
  const [promptA, promptB] = promptRecognition(grade.domain)
  const probeScores: (number | null)[] = []

  for (const provider of probers) {
    for (const [prompt, label] of [[promptA, 'prompt_1'], [promptB, 'prompt_2']] as const) {
      probeScores.push(await runOneHeuristicProbe({
        gradeId, category: 'recognition', provider, prompt, label, deps,
        scorer: (text) => ({ score: scoreRecognition({ text, domain: grade.domain }), rationale: 'recognition heuristic v1' }),
      }))
    }
  }

  const score = collapseToCategoryScore(probeScores)
  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'recognition', score })
  return score
}

export async function runCitationCategory(args: ScrapedCategoryArgs): Promise<number | null> {
  const { gradeId, grade, probers, deps } = args
  const prompt = promptCitation(grade.domain)
  const probeScores: (number | null)[] = []

  for (const provider of probers) {
    probeScores.push(await runOneHeuristicProbe({
      gradeId, category: 'citation', provider, prompt, label: 'official-url', deps,
      scorer: (text) => ({ score: scoreCitation({ text, domain: grade.domain }), rationale: 'citation heuristic v1' }),
    }))
  }

  const score = collapseToCategoryScore(probeScores)
  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'citation', score })
  return score
}

interface HeuristicProbeArgs {
  gradeId: string
  category: 'recognition' | 'citation'
  provider: Provider
  prompt: string
  label: string
  deps: RunGradeDeps
  scorer: (text: string) => { score: number; rationale: string }
}

async function runOneHeuristicProbe(a: HeuristicProbeArgs): Promise<number | null> {
  const { gradeId, category, provider, prompt, label, deps, scorer } = a
  await publishGradeEvent(deps.redis, gradeId, { type: 'probe.started', category, provider: provider.id, label })
  const start = Date.now()
  try {
    const r = await runStaticProbe({ provider, prompt, scorer })
    await deps.store.createProbe({
      gradeId, category, provider: provider.id, prompt: r.prompt, response: r.response,
      score: r.score, metadata: { label, latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, rationale: r.scoreRationale },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category, provider: provider.id, label,
      score: r.score, durationMs: Date.now() - start, error: null,
    })
    return r.score
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await deps.store.createProbe({
      gradeId, category, provider: provider.id, prompt, response: '',
      score: null, metadata: { label, error },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category, provider: provider.id, label,
      score: null, durationMs: Date.now() - start, error,
    })
    return null
  }
}

import { runSelfGenProbe } from '../../../llm/flows/self-gen.ts'
import { scoreDiscoverability } from '../../../scoring/discoverability.ts'
import { toGroundTruth } from '../../../llm/ground-truth.ts'

export async function runDiscoverabilityCategory(args: ScrapedCategoryArgs): Promise<number | null> {
  const { gradeId, grade, scrape, probers, deps } = args
  const gt = toGroundTruth(grade.url, scrape)
  const probeScores: (number | null)[] = []

  for (const provider of probers) {
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.started', category: 'discoverability', provider: provider.id, label: 'self-gen',
    })
    const start = Date.now()
    try {
      const r = await runSelfGenProbe({
        provider, groundTruth: gt,
        scorer: ({ text, brand, domain }) => scoreDiscoverability({ text, brand, domain }),
      })
      await deps.store.createProbe({
        gradeId, category: 'discoverability', provider: provider.id,
        prompt: r.probe.prompt, response: r.probe.response, score: r.score,
        metadata: {
          label: 'self-gen',
          generator: { prompt: r.generator.prompt, response: r.generator.response, latencyMs: r.generator.latencyMs, inputTokens: r.generator.inputTokens, outputTokens: r.generator.outputTokens },
          latencyMs: r.probe.latencyMs, inputTokens: r.probe.inputTokens, outputTokens: r.probe.outputTokens,
          rationale: r.scoreRationale,
        },
      })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'probe.completed', category: 'discoverability', provider: provider.id, label: 'self-gen',
        score: r.score, durationMs: Date.now() - start, error: null,
      })
      probeScores.push(r.score)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await deps.store.createProbe({
        gradeId, category: 'discoverability', provider: provider.id,
        prompt: '', response: '', score: null, metadata: { label: 'self-gen', error },
      })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'probe.completed', category: 'discoverability', provider: provider.id, label: 'self-gen',
        score: null, durationMs: Date.now() - start, error,
      })
      probeScores.push(null)
    }
  }

  const score = collapseToCategoryScore(probeScores)
  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'discoverability', score })
  return score
}
