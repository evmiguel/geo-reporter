import type Redis from 'ioredis'
import type { DirectProviders } from '../../../llm/providers/factory.ts'
import type { ScrapeResult } from '../../../scraper/index.ts'
import type { GradeStore } from '../../../store/types.ts'

export interface RunGradeDeps {
  store: GradeStore
  redis: Redis
  providers: DirectProviders
  scrapeFn: (url: string) => Promise<ScrapeResult>
  now?: () => number
}

export class GradeFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GradeFailure'
  }
}
