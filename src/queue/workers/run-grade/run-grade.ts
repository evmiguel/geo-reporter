import type { Job } from 'bullmq'
import { publishGradeEvent } from '../../events.ts'
import { weightedOverall } from '../../../scoring/composite.ts'
import { DEFAULT_WEIGHTS, type CategoryId } from '../../../scoring/weights.ts'
import { refundRateLimit } from '../../../server/middleware/rate-limit.ts'
import type { GradeJob } from '../../queues.ts'
import { GradeFailure, type RunGradeDeps } from './deps.ts'
import {
  runSeoCategory,
  runRecognitionCategory,
  runCitationCategory,
  runDiscoverabilityCategory,
  runCoverageCategory,
  runAccuracyCategory,
} from './categories.ts'
import { detectClaudeOrOpenAIOutage } from './outage-detect.ts'

export async function runGrade(job: Job<GradeJob>, deps: RunGradeDeps): Promise<void> {
  const { gradeId, tier, ip, cookie } = job.data
  const probers = tier === 'free'
    ? [deps.providers.claude, deps.providers.gpt]
    : [deps.providers.claude, deps.providers.gpt, deps.providers.gemini, deps.providers.perplexity]
  const judge = deps.providers.claude
  const generator = deps.providers.claude
  const verifier = deps.providers.claude

  try {
    await deps.store.updateGrade(gradeId, { status: 'running' })
    await publishGradeEvent(deps.redis, gradeId, { type: 'running' })

    await deps.store.clearGradeArtifacts(gradeId)

    const grade = await deps.store.getGrade(gradeId)
    if (!grade) throw new GradeFailure(`grade ${gradeId} not found`)

    const scrape = await deps.scrapeFn(grade.url)
    if (scrape.text.length < 100) {
      throw new GradeFailure('scrape produced < 100 chars of text')
    }

    await deps.store.createScrape({
      gradeId, rendered: scrape.rendered, html: scrape.html, text: scrape.text,
      structured: scrape.structured, fetchedAt: new Date(),
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'scraped', rendered: scrape.rendered, textLength: scrape.text.length,
    })

    // SEO first (sync, instant).
    const seoScore = await runSeoCategory({ gradeId, scrape, deps })

    // Discoverability acts as the canary — runs sequentially across providers.
    // A terminal Claude/OpenAI error lands in the DB as a probe row with
    // score=null + metadata.error before we fan out to the remaining categories.
    const discScore = await runDiscoverabilityCategory({ gradeId, grade, scrape, probers, deps })

    const outage = await detectClaudeOrOpenAIOutage(gradeId, deps.store)
    if (outage !== null) {
      await refundRateLimit(deps.redis, ip, cookie, gradeId)
      await deps.store.updateGrade(gradeId, { status: 'failed' })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'failed', kind: 'provider_outage', error: outage.message,
      })
      return // graceful — do NOT throw; BullMQ should NOT retry a provider outage
    }

    const [recScore, citScore, covScore, accScore] = await Promise.all([
      runRecognitionCategory({ gradeId, grade, scrape, probers, deps }),
      runCitationCategory({ gradeId, grade, scrape, probers, deps }),
      runCoverageCategory({ gradeId, grade, scrape, probers, judge, deps }),
      runAccuracyCategory({ gradeId, grade, scrape, probers, generator, verifier, deps }),
    ])

    const scores: Record<CategoryId, number | null> = {
      discoverability: discScore,
      recognition: recScore,
      accuracy: accScore,
      coverage: covScore,
      citation: citScore,
      seo: seoScore,
    }
    const overall = weightedOverall(scores, DEFAULT_WEIGHTS)

    await deps.store.updateGrade(gradeId, {
      status: 'done',
      overall: overall.overall,
      letter: overall.letter,
      scores,
    })
    await publishGradeEvent(deps.redis, gradeId, {
      type: 'done', overall: overall.overall, letter: overall.letter, scores,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.store.updateGrade(gradeId, { status: 'failed' })
    await publishGradeEvent(deps.redis, gradeId, { type: 'failed', kind: 'other', error: message })
    throw err
  }
}
