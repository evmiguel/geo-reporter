import type Redis from 'ioredis'
import type { GradeStore } from '../store/types.ts'
import type { Mailer } from '../mail/types.ts'

export interface ServerDeps {
  store: GradeStore
  redis: Redis
  redisFactory: () => Redis
  mailer: Mailer
  pingDb: () => Promise<boolean>
  pingRedis: () => Promise<boolean>
  env: {
    NODE_ENV: 'development' | 'test' | 'production'
    COOKIE_HMAC_KEY: string
    PUBLIC_BASE_URL: string
  }
}
