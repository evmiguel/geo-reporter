import { z } from 'zod'

const Schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7777),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  PERPLEXITY_API_KEY: z.string().min(1).optional(),
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

// Lazy cached env: parse `process.env` on first property access rather than at
// module import time. This is a dispatch-authorized deviation from the plan's
// eager `export const env = loadEnv()` (required because vitest imports this
// module before test env vars are set). Do NOT revert to eager — it will break
// any test that imports from this module without a fully-populated process.env.
//
// Only property `get` is proxied. `Object.keys(env)`, spreads (`{ ...env }`),
// `JSON.stringify(env)`, and `'KEY' in env` will NOT work as expected — call
// `loadEnv()` directly if you need the full object.
let cachedEnv: Env | null = null

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string | symbol) {
    if (cachedEnv === null) cachedEnv = loadEnv()
    return cachedEnv[prop as keyof Env]
  },
})
