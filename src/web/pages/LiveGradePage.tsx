import React, { useEffect, useState } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
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

export function LiveGradePage(): JSX.Element {
  const { id } = useParams<{ id: string }>()
  const [params, setParams] = useSearchParams()
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

  // Hydrate paid-report state on mount from GET /grades/:id so that a refresh
  // (after the SSE 'report.done' event has already fired) still shows the
  // View-report + Download-PDF links.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const grade = await getGrade(id)
      if (cancelled || !grade) return
      setGradeMeta({ url: grade.url, domain: grade.domain })
      if (grade.tier === 'paid' && grade.reportId !== undefined && grade.reportToken !== undefined) {
        dispatch({ type: 'hydrate_paid', reportId: grade.reportId, reportToken: grade.reportToken })
      }
    })()
    return () => { cancelled = true }
  }, [id, dispatch])

  const effectivePaidStatus: PaidStatus =
    state.paidStatus !== 'none' ? state.paidStatus :
    checkoutComplete ? 'checking_out' : 'none'

  if (state.phase === 'failed') {
    const isOutage = state.failedKind === 'provider_outage'
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">
          {isOutage ? 'LLM provider outage' : 'grade failed'}
        </div>
        <h2 className="text-xl text-[var(--color-warn)] mt-2 mb-2">
          {isOutage
            ? "Claude or ChatGPT wasn't reachable."
            : state.error ?? 'unknown error'}
        </h2>
        {isOutage && (
          <p className="text-sm text-[var(--color-fg-dim)] mb-4">
            This grade didn't count against your daily limit. Give it a minute and try again.
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
            <h1 className="text-3xl text-[var(--color-fg)] mt-1 font-mono">{gradeMeta.domain}</h1>
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

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-6">
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
        <ReportProgress paidStatus={effectivePaidStatus} reportProbeCount={state.reportProbeCount} />
      )}
      {(effectivePaidStatus === 'ready' || effectivePaidStatus === 'failed') && (
        <>
          <PaidReportStatus
            status={effectivePaidStatus}
            reportId={state.reportId}
            reportToken={state.reportToken}
            error={state.error}
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
