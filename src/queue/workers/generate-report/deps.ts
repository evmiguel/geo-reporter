import type { GradeStore } from '../../../store/types.ts'
import type Redis from 'ioredis'
import type { Provider } from '../../../llm/providers/types.ts'
import type { PdfJob } from '../../queues.ts'
import type { BillingClient } from '../../../billing/types.ts'
import type { Mailer } from '../../../mail/types.ts'
import type { runRecommender } from './recommender.ts'

export interface GenerateReportDeps {
  store: GradeStore
  redis: Redis
  providers: {
    claude: Provider
    gpt: Provider
    gemini: Provider
    perplexity: Provider
  }
  /**
   * Billing client used by the failed-job listener to auto-refund paid
   * report attempts that exhausted retries. Nullable because worker startup
   * in non-Stripe environments (local dev without STRIPE_SECRET_KEY) still
   * needs to run; the listener guards and logs-a-miss when absent.
   */
  billing: BillingClient | null
  mailer: Mailer
  recommenderFn: typeof runRecommender
  enqueuePdfFn: (job: PdfJob) => Promise<void>
}
