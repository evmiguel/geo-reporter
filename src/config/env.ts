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
  COOKIE_HMAC_KEY: z.string().min(32).optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  STRIPE_PRICE_ID: z.string().startsWith('price_').optional(),
  STRIPE_CREDITS_PRICE_ID: z.string().startsWith('price_').optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  // RFC 5322 mailbox: can be bare `addr` or display-name form `Name <addr>`.
  // Resend (and most providers) accept both. Validation lives at the mailer
  // boundary, not the env layer.
  MAIL_FROM: z.string().min(1).optional(),
  // Cloudflare Turnstile — optional in dev. When absent, the verify middleware
  // skips enforcement (logs a warning at startup) so `pnpm dev` keeps working
  // without a real Cloudflare account. Required in production.
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
  if (val.NODE_ENV === 'production') {
    const required = [
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY',
      'COOKIE_HMAC_KEY', 'PUBLIC_BASE_URL',
      'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID',
      'STRIPE_CREDITS_PRICE_ID',
      'TURNSTILE_SECRET_KEY',
    ] as const
    for (const key of required) {
      if (!val[key]) {
        ctx.addIssue({ code: 'custom', message: `${key} is required in production`, path: [key] })
      }
    }
  }
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
