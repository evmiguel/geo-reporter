import React, { useEffect, useState } from 'react'
import { useParams, Link, useSearchParams, useLocation, useNavigate } from 'react-router-dom'
import { useGradeEvents } from '../hooks/useGradeEvents.ts'
import { useAuth } from '../hooks/useAuth.ts'
import { StatusBar } from '../components/StatusBar.tsx'
import { CategoryTile } from '../components/CategoryTile.tsx'
import { ProbeLogRow } from '../components/ProbeLogRow.tsx'
import { GradeLetter } from '../components/GradeLetter.tsx'
import { BuyReportButton } from '../components/BuyReportButton.tsx'
import { BuyCreditsCTA } from '../components/BuyCreditsCTA.tsx'
import { HowWeGradeCard } from '../components/HowWeGradeCard.tsx'
import { PaidReportPreview } from '../components/PaidReportPreview.tsx'
import { PaidReportStatus } from '../components/PaidReportStatus.tsx'
import { ReportProgress } from '../components/ReportProgress.tsx'
import { CheckoutCanceledToast } from '../components/CheckoutCanceledToast.tsx'
import { getGrade } from '../lib/api.ts'
import { CATEGORY_ORDER, CATEGORY_WEIGHTS, type PaidStatus } from '../lib/types.ts'
import { messageForFailKind, type FailKind } from '../lib/fail-messages.ts'

export function LiveGradePage(): JSX.Element {
  const { id } = useParams<{ id: string }>()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const fromSubmit = (location.state as { fromSubmit?: boolean } | null)?.fromSubmit === true
  const [canceledToast, setCanceledToast] = useState<boolean>(params.get('checkout') === 'canceled')
  const [checkoutComplete] = useState<boolean>(params.get('checkout') === 'complete')
  const [gradeMeta, setGradeMeta] = useState<{ url: string; domain: string } | null>(null)

  useEffect(() => {
    if (params.get('checkout') !== null || params.get('verified') !== null) {
      const next = new URLSearchParams(params)
      next.delete('checkout')
      next.delete('verified')
      setParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (id === undefined) return <div className="p-8 text-[var(--color-warn)]">invalid grade id</div>
  const { state, dispatch } = useGradeEvents(id)
  const { credits } = useAuth()

  // Hydrate paid-report state on mount from GET /grades/:id so a refresh
  // doesn't strand the user:
  //  - Report already written → hydrate 'ready' with reportId/token
  //  - Payment received but generation still in flight (tier flips to paid
  //    LAST, ~30-60s window) → hydrate 'generating' so ReportProgress shows
  //    instead of BuyReportButton asking them to pay again.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const grade = await getGrade(id)
      if (cancelled || !grade) return
      setGradeMeta({ url: grade.url, domain: grade.domain })
      if (grade.reportId !== undefined && grade.reportToken !== undefined) {
        dispatch({ type: 'hydrate_paid', reportId: grade.reportId, reportToken: grade.reportToken })
      } else if (grade.paymentPaid === true) {
        dispatch({ type: 'hydrate_generating' })
      }
    })()
    return () => { cancelled = true }
  }, [id, dispatch])

  const effectivePaidStatus: PaidStatus =
    state.paidStatus !== 'none' ? state.paidStatus :
    checkoutComplete ? 'checking_out' : 'none'

  // Slow-failure fallback for the submit-from-landing flow: if the grade
  // fails after the 12s peek already navigated us here, redirect back to
  // the landing page with the error inline — so we never actually render
  // the "grade failed" screen for users who just submitted. Direct visits
  // to a failed grade URL (from account history, shared link) keep the
  // old in-place error UI because `fromSubmit` will be false.
  const isPostSubmitFailure = state.phase === 'failed' && fromSubmit
  useEffect(() => {
    if (!isPostSubmitFailure) return
    const failKind: FailKind = (state.failedKind as FailKind | null) ?? 'other'
    navigate('/', {
      replace: true,
      state: { postSubmitFailure: { message: messageForFailKind(failKind) } },
    })
  }, [isPostSubmitFailure, state.failedKind, navigate])
  if (isPostSubmitFailure) {
    // Render an empty shell while the effect fires the redirect. One frame,
    // no flash of the failure copy.
    return <div className="max-w-3xl mx-auto px-4 py-8" />
  }

  if (state.phase === 'failed') {
    const isOutage = state.failedKind === 'provider_outage'
    const isScrapeFail = state.failedKind === 'scrape_failed'
    // Only provider outages refund the slot now — scrape failures are
    // on the user's URL choice (hostile sites still eat a slot).
    const refunded = isOutage
    const label =
      isOutage ? 'LLM provider outage' :
      isScrapeFail ? "couldn't fetch that site" :
      'grade failed'
    const headline =
      isOutage ? "Claude or ChatGPT wasn't reachable." :
      isScrapeFail ? "We couldn't read that page." :
      state.error ?? 'unknown error'
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">
          {label}
        </div>
        <h2 className="text-xl text-[var(--color-warn)] mt-2 mb-2">
          {headline}
        </h2>
        {isScrapeFail && (
          <p className="text-sm text-[var(--color-fg-dim)] mb-2">
            Some sites block automated tools. Marketing pages, blogs, and personal sites work best.
            Reddit, X/Twitter, Facebook, and login-gated apps usually don't.
          </p>
        )}
        {refunded && (
          <p className="text-sm text-[var(--color-fg-dim)] mb-4">
            This grade didn't count against your daily limit.
            {isOutage && ' Give it a minute and try again.'}
          </p>
        )}
        <Link to="/" className="text-[var(--color-brand)] underline">try another URL →</Link>
      </div>
    )
  }

  const sortedProbes = [...state.probes.values()].sort((a, b) => a.startedAt - b.startedAt)
  const isFreeTierDone = state.phase === 'done' && effectivePaidStatus === 'none'

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">live grade</div>
        {gradeMeta && (
          <>
            <h1 className="text-2xl sm:text-3xl text-[var(--color-fg)] mt-1 font-mono break-all">{gradeMeta.domain}</h1>
            <div className="text-sm text-[var(--color-fg-dim)] mt-1 break-all">{gradeMeta.url}</div>
          </>
        )}
      </div>

      {state.phase === 'done' && state.letter !== null && state.overall !== null ? (
        <div className="mt-4 mb-6">
          <GradeLetter letter={state.letter} overall={state.overall} />
        </div>
      ) : (
        <div className="mt-2 mb-6">
          <StatusBar phase={state.phase} scraped={state.scraped} />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 mb-6">
        {CATEGORY_ORDER.map((cat) => (
          <CategoryTile
            key={cat}
            category={cat}
            weight={CATEGORY_WEIGHTS[cat]}
            score={state.categoryScores[cat]}
            phase={state.phase}
          />
        ))}
      </div>

      <HowWeGradeCard />

      {isFreeTierDone && gradeMeta !== null && state.letter !== null && state.overall !== null && (
        <PaidReportPreview
          domain={gradeMeta.domain}
          letter={state.letter}
          overall={state.overall}
        />
      )}

      {isFreeTierDone && (
        <BuyReportButton
          gradeId={id}
          onAlreadyPaid={() => { /* reducer's next event will transition us */ }}
        />
      )}

      {(effectivePaidStatus === 'checking_out' || effectivePaidStatus === 'generating') && (
        <ReportProgress
          paidStatus={effectivePaidStatus}
          reportPhase={state.reportPhase}
          reportProbeCount={state.reportProbeCount}
        />
      )}
      {(effectivePaidStatus === 'ready' || effectivePaidStatus === 'failed' || effectivePaidStatus === 'refunded') && (
        <>
          <PaidReportStatus
            status={effectivePaidStatus}
            reportId={state.reportId}
            reportToken={state.reportToken}
            error={state.error}
            refundKind={state.paidRefundKind}
          />
          {effectivePaidStatus === 'ready' && credits === 0 && <BuyCreditsCTA />}
        </>
      )}

      <div className="border-t border-[var(--color-line)] pt-6 mt-8">
        <h2 className="text-lg text-[var(--color-fg)] mb-3 pb-2 border-b border-[var(--color-line)]">Probes</h2>
        <div className="flex flex-col">
          {sortedProbes.map((probe) => (
            <ProbeLogRow key={probe.key} probe={probe} />
          ))}
        </div>
      </div>

      {canceledToast && <CheckoutCanceledToast onDismiss={() => setCanceledToast(false)} />}
    </div>
  )
}
