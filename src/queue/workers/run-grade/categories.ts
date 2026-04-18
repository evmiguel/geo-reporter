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

import { runCoverageFlow } from '../../../llm/flows/coverage.ts'
import type { ProviderId } from '../../../llm/providers/types.ts'

export interface CoverageCategoryArgs extends ScrapedCategoryArgs {
  judge: Provider
}

export async function runCoverageCategory(args: CoverageCategoryArgs): Promise<number | null> {
  const { gradeId, grade, scrape, probers, judge, deps } = args
  const gt = toGroundTruth(grade.url, scrape)
  const prompts = ['prompt_1', 'prompt_2'] as const

  for (const provider of probers) {
    for (const label of prompts) {
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'probe.started', category: 'coverage', provider: provider.id, label,
      })
    }
  }

  const start = Date.now()
  let result: Awaited<ReturnType<typeof runCoverageFlow>>
  let flowError: string | null = null
  try {
    result = await runCoverageFlow({ providers: probers, judge, groundTruth: gt })
  } catch (err) {
    flowError = err instanceof Error ? err.message : String(err)
    result = { probes: [], judge: { prompt: '', rawResponse: '', perProbe: new Map(), perProvider: {}, degraded: true } }
  }
  const durationMs = Date.now() - start

  const probeScores: (number | null)[] = []
  let probeIdx = 0
  for (const provider of probers) {
    for (const label of prompts) {
      const probe = result.probes[probeIdx]
      probeIdx++
      const perProbeKey = `probe_${probeIdx}`
      const perProbe = result.judge.perProbe.get(perProbeKey)
      const perProvider = result.judge.perProvider[provider.id as ProviderId]

      if (!probe || probe.error !== null || probe.response === '') {
        const error = probe?.error ?? flowError ?? 'unknown'
        await deps.store.createProbe({
          gradeId, category: 'coverage', provider: provider.id, prompt: probe?.prompt ?? '', response: '', score: null,
          metadata: { label, error, judgeDegraded: result.judge.degraded },
        })
        await publishGradeEvent(deps.redis, gradeId, {
          type: 'probe.completed', category: 'coverage', provider: provider.id, label,
          score: null, durationMs, error,
        })
        probeScores.push(null)
        continue
      }

      const judgeAccuracy = perProbe?.accuracy ?? perProvider?.accuracy ?? null
      const judgeCoverage = perProbe?.coverage ?? perProvider?.coverage ?? null
      const judgeNotes = perProbe?.notes ?? perProvider?.notes ?? ''
      const score = judgeAccuracy !== null && judgeCoverage !== null
        ? Math.round((judgeAccuracy + judgeCoverage) / 2)
        : null

      await deps.store.createProbe({
        gradeId, category: 'coverage', provider: provider.id,
        prompt: probe.prompt, response: probe.response, score,
        metadata: {
          label, latencyMs: probe.latencyMs, inputTokens: probe.inputTokens, outputTokens: probe.outputTokens,
          judgeAccuracy, judgeCoverage, judgeNotes, judgeDegraded: result.judge.degraded,
        },
      })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'probe.completed', category: 'coverage', provider: provider.id, label,
        score, durationMs, error: null,
      })
      probeScores.push(score)
    }
  }

  const score = collapseToCategoryScore(probeScores)
  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'coverage', score })
  return score
}

import { runAccuracy } from '../../../accuracy/index.ts'

export interface AccuracyCategoryArgs extends ScrapedCategoryArgs {
  generator: Provider
  verifier: Provider
}

export async function runAccuracyCategory(args: AccuracyCategoryArgs): Promise<number | null> {
  const { gradeId, grade, scrape, probers, generator, verifier, deps } = args

  let result
  try {
    result = await runAccuracy({ generator, verifier, probers, url: grade.url, scrape })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await deps.store.createProbe({
      gradeId, category: 'accuracy', provider: null,
      prompt: '', response: '', score: null,
      metadata: { role: 'skipped', reason: 'generator_failed', error },
    })
    await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'accuracy', score: null })
    return null
  }

  if (result.reason !== 'ok') {
    await deps.store.createProbe({
      gradeId, category: 'accuracy', provider: null,
      prompt: '', response: '', score: null,
      metadata: { role: 'skipped', reason: result.reason },
    })
    await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'accuracy', score: null })
    return null
  }

  let generatorProbeId: string | null = null
  if (result.generator) {
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.started', category: 'accuracy', provider: generator.id, label: 'generator',
    })
    const generatorRow = await deps.store.createProbe({
      gradeId, category: 'accuracy', provider: generator.id,
      prompt: result.generator.prompt, response: result.generator.response, score: null,
      metadata: {
        role: 'generator',
        latencyMs: result.generator.latencyMs,
        inputTokens: result.generator.inputTokens,
        outputTokens: result.generator.outputTokens,
      },
    })
    generatorProbeId = generatorRow.id
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category: 'accuracy', provider: generator.id, label: 'generator',
      score: null, durationMs: result.generator.latencyMs, error: null,
    })
  }

  const question = result.generator?.question ?? ''
  for (const probe of result.probes) {
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.started', category: 'accuracy', provider: probe.providerId, label: 'verify',
    })
    const verification = result.verifications.find((v) => v.providerId === probe.providerId)
    const score = verification
      ? (verification.correct === true ? 100 : verification.correct === false ? 0 : null)
      : null
    const error = probe.error ?? (verification?.degraded ? 'verifier degraded' : null)

    await deps.store.createProbe({
      gradeId, category: 'accuracy', provider: probe.providerId,
      prompt: question, response: probe.answer, score,
      metadata: {
        role: 'verify',
        generatorProbeId,
        confidence: verification?.confidence ?? null,
        rationale: verification?.rationale ?? null,
        degraded: verification?.degraded ?? false,
        verifierProviderId: verifier.id,
        latencyMs: probe.latencyMs,
        inputTokens: probe.inputTokens,
        outputTokens: probe.outputTokens,
        error,
      },
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'probe.completed', category: 'accuracy', provider: probe.providerId, label: 'verify',
      score, durationMs: probe.latencyMs, error,
    })
  }

  await publishGradeEvent(deps.redis, gradeId, { type: 'category.completed', category: 'accuracy', score: result.score })
  return result.score
}
