import type Redis from 'ioredis'
import type { ProviderId } from '../llm/providers/types.ts'
import type { CategoryId } from '../scoring/weights.ts'

export type GradeEvent =
  | { type: 'running' }
  | { type: 'scraped'; rendered: boolean; textLength: number }
  | { type: 'probe.started'; category: CategoryId; provider: ProviderId | null; label: string }
  | {
      type: 'probe.completed'
      category: CategoryId
      provider: ProviderId | null
      label: string
      score: number | null
      durationMs: number
      error: string | null
    }
  | { type: 'category.completed'; category: CategoryId; score: number | null }
  | { type: 'done'; overall: number; letter: string; scores: Record<CategoryId, number | null> }
  | { type: 'failed'; kind: 'provider_outage' | 'other'; error: string }
  // Plan 8 — paid-report pipeline
  | { type: 'report.started' }
  | {
      type: 'report.probe.started'
      category: CategoryId
      provider: ProviderId
      label: string
    }
  | {
      type: 'report.probe.completed'
      category: CategoryId
      provider: ProviderId
      label: string
      score: number | null
      durationMs: number
      error: string | null
    }
  | { type: 'report.recommendations.started' }
  | { type: 'report.recommendations.completed'; count: number }
  | { type: 'report.done'; reportId: string; token: string }
  | { type: 'report.failed'; error: string }

export function channelFor(gradeId: string): string {
  return `grade:${gradeId}`
}

export async function publishGradeEvent(
  redis: Redis,
  gradeId: string,
  event: GradeEvent,
): Promise<void> {
  await redis.publish(channelFor(gradeId), JSON.stringify(event))
}

export function subscribeToGrade(
  redis: Redis,
  gradeId: string,
  signal?: AbortSignal,
): AsyncIterable<GradeEvent> {
  const channel = channelFor(gradeId)
  return {
    [Symbol.asyncIterator](): AsyncIterator<GradeEvent> {
      const queue: GradeEvent[] = []
      let waiter: ((ev: IteratorResult<GradeEvent>) => void) | null = null
      let done = false

      const finish = (): void => {
        if (done) return
        done = true
        void redis.unsubscribe(channel).catch(() => undefined)
        redis.removeListener('message', onMessage)
        if (waiter) {
          waiter({ value: undefined, done: true })
          waiter = null
        }
      }

      const onMessage = (ch: string, payload: string): void => {
        if (ch !== channel) return
        let event: GradeEvent
        try {
          event = JSON.parse(payload) as GradeEvent
        } catch {
          return
        }
        if (waiter) {
          const w = waiter
          waiter = null
          w({ value: event, done: false })
        } else {
          queue.push(event)
        }
        if (
          event.type === 'done' ||
          event.type === 'failed' ||
          event.type === 'report.done' ||
          event.type === 'report.failed'
        ) finish()
      }

      redis.on('message', onMessage)
      void redis.subscribe(channel).catch(() => finish())

      if (signal) {
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      }

      return {
        next(): Promise<IteratorResult<GradeEvent>> {
          if (queue.length > 0) {
            const v = queue.shift() as GradeEvent
            return Promise.resolve({ value: v, done: false })
          }
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiter = resolve
          })
        },
        return(): Promise<IteratorResult<GradeEvent>> {
          finish()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}
