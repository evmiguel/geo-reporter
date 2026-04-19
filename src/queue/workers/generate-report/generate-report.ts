import { randomBytes } from 'node:crypto'
import { publishGradeEvent, type GradeEvent } from '../../events.ts'
import { rescoreFromProbes } from '../../../scoring/rescore.ts'
import { runDeltaProbes } from './probes.ts'
import type { GenerateReportDeps } from './deps.ts'
import type { ScrapeResult } from '../../../scraper/types.ts'

export interface GenerateReportJob { gradeId: string; sessionId: string }

export async function generateReport(
  deps: GenerateReportDeps,
  job: GenerateReportJob,
): Promise<void> {
  const { gradeId } = job
  const publish = async (ev: GradeEvent): Promise<void> => {
    await publishGradeEvent(deps.redis, gradeId, ev)
  }

  await publish({ type: 'report.started' })

  const grade = await deps.store.getGrade(gradeId)
  if (!grade) throw new Error(`generateReport: grade ${gradeId} not found`)
  if (grade.status !== 'done') throw new Error(`generateReport: grade ${gradeId} status=${grade.status}`)
  if (grade.tier !== 'free') throw new Error(`generateReport: grade ${gradeId} tier=${grade.tier}`)

  const scrape = await deps.store.getScrape(gradeId)
  if (!scrape) throw new Error(`generateReport: scrape for ${gradeId} not found`)

  // Step 1: delta probes (Gemini + Perplexity)
  const scrapeForProbes: ScrapeResult = {
    rendered: scrape.rendered,
    html: scrape.html,
    text: scrape.text,
    structured: scrape.structured as never,
  }
  await runDeltaProbes({
    store: deps.store,
    providers: {
      gemini: deps.providers.gemini,
      perplexity: deps.providers.perplexity,
      claudeForJudge: deps.providers.claude,
      generator: deps.providers.claude,
      verifier: deps.providers.claude,
    },
    publishEvent: publish,
  }, { grade, scrape: scrapeForProbes })

  // Step 2: recompute composite from all probes (4 providers + SEO)
  const allProbes = await deps.store.listProbes(gradeId)
  const rescored = rescoreFromProbes(allProbes)

  // Step 3: recommendation LLM
  await publish({ type: 'report.recommendations.started' })
  const seoFailingSignals = allProbes
    .filter((p) => p.category === 'seo' && p.score !== null && p.score < 100)
    .map((p) => ({
      label: String((p.metadata as { label?: string }).label ?? (p.metadata as { signal?: string }).signal ?? 'unknown'),
      detail: p.response,
    }))
  const accuracyQuestionProbes = allProbes.filter((p) => p.category === 'accuracy' && p.provider === null)
  const accuracyAnswerProbes = allProbes.filter((p) => p.category === 'accuracy' && p.provider !== null)
  const llmDescriptions = allProbes
    .filter((p) => p.category === 'recognition')
    .map((p) => ({ provider: p.provider ?? 'unknown', description: p.response }))

  const recResult = await deps.recommenderFn({ provider: deps.providers.claude }, {
    gradeId,
    url: grade.url,
    scores: rescored.scores,
    failingSeoSignals: seoFailingSignals,
    accuracyQuestion: accuracyQuestionProbes[0]?.response ?? null,
    accuracyAnswers: accuracyAnswerProbes.map((p) => ({ provider: p.provider ?? 'unknown', response: p.response })),
    llmDescriptions,
    scrapeText: scrape.text,
  })
  if (recResult.recommendations.length > 0) {
    await deps.store.createRecommendations(recResult.recommendations)
  }
  await publish({ type: 'report.recommendations.completed', count: recResult.recommendations.length })

  // Step 4: reports row (token is the capability)
  const token = randomBytes(32).toString('hex')
  const report = await deps.store.createReport({ gradeId, token })

  // Step 5: scores update (penultimate write)
  const existingScores = (grade.scores as { metadata?: Record<string, unknown> } | null) ?? {}
  const newScores: Record<string, unknown> = {
    ...rescored.scores,
    metadata: {
      ...(existingScores.metadata ?? {}),
      ...(recResult.limited ? { recommendationsLimited: true } : {}),
    },
  }
  await deps.store.updateGrade(gradeId, {
    overall: rescored.overall,
    letter: rescored.letter,
    scores: newScores as never,
  })

  // Step 6: tier flip (LAST write — invariant: tier='paid' means report is ready)
  await deps.store.updateGrade(gradeId, { tier: 'paid' })

  await publish({ type: 'report.done', reportId: report.id, token })
}
