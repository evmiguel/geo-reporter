import type { Job } from 'bullmq'
import { publishGradeEvent } from '../../events.ts'
import { weightedOverall } from '../../../scoring/composite.ts'
import { DEFAULT_WEIGHTS, type CategoryId } from '../../../scoring/weights.ts'
import { refundRateLimit } from '../../../server/middleware/rate-limit.ts'
import type { GradeStore } from '../../../store/types.ts'
import type { GradeJob } from '../../queues.ts'
import { GradeFailure, type RunGradeDeps } from './deps.ts'

/**
 * Return a credit when a credit-redeemed grade fails before completing.
 *
 * /grades/redeem decrements the user's credit at submit time and writes a
 * paid stripe_payments row (kind='credits'). If scraping or the provider
 * outage check fails, we owe the credit back: increment the user's
 * balance, flip the audit row to 'refunded'. Stripe $19 grades can't
 * reach this path — /billing/checkout requires status='done' — so credit
 * is the only shape we have to handle here. Plan 15's
 * autoRefundFailedReport covers post-done failures.
 */
async function refundCreditIfRedeemed(store: GradeStore, gradeId: string): Promise<void> {
  const payments = await store.listStripePaymentsByGrade(gradeId)
  const paid = payments.find((p) => p.status === 'paid' && p.kind === 'credits')
  if (!paid) return
  const grade = await store.getGrade(gradeId)
  if (!grade?.userId) return
  try {
    await store.incrementCredits(grade.userId, 1)
    await store.updateStripePaymentStatus(paid.sessionId, { status: 'refunded' })
  } catch (err) {
    console.error(JSON.stringify({
      msg: 'credit-refund-failed',
      gradeId,
      sessionId: paid.sessionId,
      error: err instanceof Error ? err.message : String(err),
    }))
  }
}
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

    // Scrape is isolated in its own try/catch: when it fails (site blocks bots,
    // DNS miss, render timeout, login wall producing <100 chars) we return
    // gracefully without throwing (avoiding BullMQ retry on a deterministic
    // failure).
    //
    // NOTE: scrape failures do NOT refund the rate-limit slot. The user
    // chose the URL; if reddit/x.com/hostile sites keep rejecting us, that's
    // their pick — not our infrastructure. Refunding here would let a
    // scripted attacker chew through Playwright's worker pool indefinitely
    // (each attempt eats ~25s of wall-clock before refunding and freeing
    // the slot). Credit refunds still fire — money must not vanish for a
    // failed scrape — and provider_outage (Claude/GPT down, our fault)
    // keeps refunding both.
    let scrape: Awaited<ReturnType<typeof deps.scrapeFn>>
    try {
      scrape = await deps.scrapeFn(grade.url)
      if (scrape.text.length < 100) {
        throw new GradeFailure('scrape produced < 100 chars of text')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await refundCreditIfRedeemed(deps.store, gradeId)
      await deps.store.updateGrade(gradeId, { status: 'failed' })
      await publishGradeEvent(deps.redis, gradeId, {
        type: 'failed', kind: 'scrape_failed', error: message,
      })
      return
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
      await refundRateLimit(deps.redis, deps.store, ip, cookie, gradeId)
      await refundCreditIfRedeemed(deps.store, gradeId)
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

    // Credit-overflow path: /grades/redeem writes a paid stripe_payments row
    // at grade creation time so we'd auto-promote to the full paid report
    // once the free-tier scoring is done. This keeps the Stripe-after-grade
    // flow working unchanged (webhook still drives enqueue; deterministic
    // jobId means BullMQ dedups on the overlap case).
    if (deps.reportQueue) {
      const payments = await deps.store.listStripePaymentsByGrade(gradeId)
      const paid = payments.find((p) => p.status === 'paid')
      if (paid) {
        await deps.reportQueue.add(
          'generate-report',
          { gradeId, sessionId: paid.sessionId },
          {
            jobId: `generate-report-auto-${gradeId}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
          },
        )
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.store.updateGrade(gradeId, { status: 'failed' })
    await publishGradeEvent(deps.redis, gradeId, { type: 'failed', kind: 'other', error: message })
    throw err
  }
}
