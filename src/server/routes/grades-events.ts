import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { subscribeToGrade, type GradeEvent } from '../../queue/events.ts'
import type { CategoryId } from '../../scoring/weights.ts'
import type { ProviderId } from '../../llm/providers/types.ts'
import { isOwnedBy } from '../lib/grade-ownership.ts'
import type { ServerDeps } from '../deps.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Env = { Variables: { cookie: string; clientIp: string; userId: string | null } }

export function gradesEventsRouter(deps: ServerDeps): Hono<Env> {
  const app = new Hono<Env>()

  app.get('/:id/events', async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400)
    const grade = await deps.store.getGrade(id)
    if (!grade) return c.json({ error: 'not found' }, 404)
    if (!isOwnedBy(grade, { cookie: c.var.cookie, userId: c.var.userId })) {
      return c.json({ error: 'forbidden' }, 403)
    }

    return streamSSE(c, async (stream) => {
      const send = async (ev: GradeEvent): Promise<void> => {
        await stream.writeSSE({ data: JSON.stringify(ev) })
      }

      // Terminal: grade itself failed — emit failed and return.
      if (grade.status === 'failed') {
        await send({ type: 'failed', kind: 'other', error: 'grade failed' })
        return
      }

      // Hydrate past state (for reconnects / late subscribers).
      // Send 'running' for any non-terminal status so the frontend knows the pipeline
      // is active, and to avoid races where the worker publishes 'running' before
      // this subscriber connects.
      if (grade.status === 'running' || grade.status === 'queued') {
        await send({ type: 'running' })
      }
      const scrape = await deps.store.getScrape(grade.id)
      if (scrape) {
        await send({ type: 'scraped', rendered: scrape.rendered, textLength: scrape.text.length })
      }
      const probes = await deps.store.listProbes(grade.id)
      const ordered = [...probes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      for (const probe of ordered) {
        const meta = (probe.metadata ?? {}) as { label?: string; latencyMs?: number; error?: string | null }
        const label = meta.label ?? ''
        const durationMs = meta.latencyMs ?? 0
        const error = meta.error ?? null
        if (probe.provider === 'gemini' || probe.provider === 'perplexity') {
          await send({
            type: 'report.probe.completed',
            category: probe.category as CategoryId,
            provider: probe.provider,
            label,
            score: probe.score,
            durationMs,
            error,
          })
        } else {
          await send({
            type: 'probe.completed',
            category: probe.category as CategoryId,
            provider: probe.provider as ProviderId | null,
            label,
            score: probe.score,
            durationMs,
            error,
          })
        }
      }

      if (grade.status === 'done') {
        await send({
          type: 'done',
          overall: grade.overall ?? 0,
          letter: grade.letter ?? 'F',
          scores: (grade.scores ?? {}) as Record<CategoryId, number | null>,
        })
      }

      // Paid-tier terminal hydration: emit report.done if report row exists.
      if (grade.tier === 'paid') {
        const report = await deps.store.getReport(grade.id)
        if (report) {
          await send({ type: 'report.done', reportId: report.id, token: report.token })
          return
        }
      }

      // Non-terminal: subscribe for live events (queued/running, or done awaiting report generation).
      const subscriber = deps.redisFactory()
      const abortCtrl = new AbortController()
      const onAbort = (): void => abortCtrl.abort()
      c.req.raw.signal.addEventListener('abort', onAbort, { once: true })

      try {
        for await (const event of subscribeToGrade(subscriber, grade.id, abortCtrl.signal)) {
          await send(event)
          if (
            event.type === 'done' ||
            event.type === 'failed' ||
            event.type === 'report.done' ||
            event.type === 'report.failed'
          ) break
        }
      } finally {
        c.req.raw.signal.removeEventListener('abort', onAbort)
        await subscriber.quit()
      }
    })
  })

  return app
}
