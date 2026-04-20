import type Redis from 'ioredis'
import type { Queue } from 'bullmq'
import type { GradeStore } from '../store/types.ts'
import type { Mailer } from '../mail/types.ts'
import type { BillingClient } from '../billing/types.ts'
import type { ReportJob } from '../queue/queues.ts'

export interface ServerDeps {
  store: GradeStore
  redis: Redis
  redisFactory: () => Redis
  mailer: Mailer
  billing: BillingClient | null
  reportQueue: Queue<ReportJob>
  pingDb: () => Promise<boolean>
  pingRedis: () => Promise<boolean>
  env: {
    NODE_ENV: 'development' | 'test' | 'production'
    COOKIE_HMAC_KEY: string
    PUBLIC_BASE_URL: string
    STRIPE_PRICE_ID: string | null
    STRIPE_WEBHOOK_SECRET: string | null
    STRIPE_CREDITS_PRICE_ID: string | null
    TRUSTED_PROXIES?: string | null
  }
}
