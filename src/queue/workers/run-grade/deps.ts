import type Redis from 'ioredis'
import type { Queue } from 'bullmq'
import type { DirectProviders } from '../../../llm/providers/factory.ts'
import type { ScrapeResult } from '../../../scraper/index.ts'
import type { GradeStore } from '../../../store/types.ts'
import type { ReportJob } from '../../queues.ts'

export interface RunGradeDeps {
  store: GradeStore
  redis: Redis
  providers: DirectProviders
  scrapeFn: (url: string) => Promise<ScrapeResult>
  /**
   * Optional — when present, the worker auto-enqueues generate-report after
   * a grade completes if a paid stripe_payments row exists for it. This is
   * what closes the loop for the /grades/redeem flow (credit spent up front,
   * grade runs, report generation chains automatically). For the existing
   * Stripe-after-grade flow the webhook still drives enqueue; BullMQ's
   * jobId dedup makes the double-enqueue path safe.
   */
  reportQueue?: Queue<ReportJob>
  now?: () => number
}

export class GradeFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GradeFailure'
  }
}
