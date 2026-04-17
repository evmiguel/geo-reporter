import { z } from 'zod'

const Schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7777),
})

export type Env = z.infer<typeof Schema>

export function loadEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  const result = Schema.safeParse(raw)
  if (!result.success) {
    const missing = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
    throw new Error(`Invalid environment: ${missing}`)
  }
  return result.data
}

// Lazy cached env: parse `process.env` on first access rather than at module
// import time. This keeps runtime semantics (loadEnv on first use) while
// letting tests import `loadEnv` without triggering a parse against an
// incomplete real `process.env`.
let cachedEnv: Env | null = null

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string | symbol) {
    if (cachedEnv === null) cachedEnv = loadEnv()
    return cachedEnv[prop as keyof Env]
  },
})
