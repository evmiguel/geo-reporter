import type { GradeStore } from '../../../store/types.ts'
import type Redis from 'ioredis'
import type { Provider } from '../../../llm/providers/types.ts'
import type { PdfJob } from '../../queues.ts'
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
  recommenderFn: typeof runRecommender
  enqueuePdfFn: (job: PdfJob) => Promise<void>
}
