import { describe, expect, it, vi } from 'vitest'
import { loadEnv } from '../../../src/config/env.ts'

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://u:p@h:1/d',
      REDIS_URL: 'redis://h:1',
      NODE_ENV: 'test',
      PORT: '8080',
    })
    expect(env.PORT).toBe(8080)
    expect(env.NODE_ENV).toBe('test')
  })

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadEnv({ REDIS_URL: 'redis://h:1' })).toThrow(/DATABASE_URL/)
  })

  it('defaults PORT to 7777', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://u:p@h:1/d',
      REDIS_URL: 'redis://h:1',
    })
    expect(env.PORT).toBe(7777)
  })
})

describe('env (lazy Proxy)', () => {
  it('parses process.env on first access and caches', async () => {
    const prev = { ...process.env }
    process.env.DATABASE_URL = 'postgres://u:p@h:1/d'
    process.env.REDIS_URL = 'redis://h:1'
    process.env.PORT = '9090'
    delete process.env.NODE_ENV
    try {
      // Reset the module cache so the Proxy's `cachedEnv` starts as null.
      vi.resetModules()
      const mod = await import('../../../src/config/env.ts')
      const { env } = mod
      expect(env.PORT).toBe(9090)
      // Mutate process.env after first access; cached value should NOT change.
      process.env.PORT = '1234'
      expect(env.PORT).toBe(9090)
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k]
      Object.assign(process.env, prev)
    }
  })
})

describe('env — Plan 7 auth vars', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o',
    GEMINI_API_KEY: 'sk-g', PERPLEXITY_API_KEY: 'sk-p',
  }

  it('accepts missing COOKIE_HMAC_KEY in development', () => {
    const result = loadEnv({ ...base, NODE_ENV: 'development' })
    expect(result.COOKIE_HMAC_KEY).toBeUndefined()
    expect(result.PUBLIC_BASE_URL).toBeUndefined()
  })

  it('accepts COOKIE_HMAC_KEY at 32 chars', () => {
    const key = 'a'.repeat(32)
    const result = loadEnv({ ...base, NODE_ENV: 'development', COOKIE_HMAC_KEY: key })
    expect(result.COOKIE_HMAC_KEY).toBe(key)
  })

  it('rejects COOKIE_HMAC_KEY shorter than 32 chars', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', COOKIE_HMAC_KEY: 'short' })).toThrow(/COOKIE_HMAC_KEY/)
  })

  it('requires COOKIE_HMAC_KEY in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/COOKIE_HMAC_KEY/)
  })

  it('requires PUBLIC_BASE_URL in production', () => {
    expect(() => loadEnv({
      ...base, NODE_ENV: 'production',
      COOKIE_HMAC_KEY: 'a'.repeat(32),
    })).toThrow(/PUBLIC_BASE_URL/)
  })

  it('rejects non-URL PUBLIC_BASE_URL', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', PUBLIC_BASE_URL: 'not a url' })).toThrow(/PUBLIC_BASE_URL/)
  })

  it('accepts fully-configured production env', () => {
    const env = loadEnv({
      ...base, NODE_ENV: 'production',
      COOKIE_HMAC_KEY: 'a'.repeat(32),
      PUBLIC_BASE_URL: 'https://geo-reporter.com',
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
      STRIPE_PRICE_ID: 'price_abc',
    })
    expect(env.PUBLIC_BASE_URL).toBe('https://geo-reporter.com')
  })
})

describe('env — Plan 8 Stripe vars', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o',
    GEMINI_API_KEY: 'sk-g', PERPLEXITY_API_KEY: 'sk-p',
    COOKIE_HMAC_KEY: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'http://localhost:5173',
  }

  it('accepts missing Stripe keys in development', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development' })
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.STRIPE_WEBHOOK_SECRET).toBeUndefined()
    expect(env.STRIPE_PRICE_ID).toBeUndefined()
  })

  it('accepts test-mode Stripe keys', () => {
    const env = loadEnv({
      ...base, NODE_ENV: 'development',
      STRIPE_SECRET_KEY: 'sk_test_abc123',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
      STRIPE_PRICE_ID: 'price_abc123',
    })
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_abc123')
    expect(env.STRIPE_PRICE_ID).toBe('price_abc123')
  })

  it('rejects STRIPE_SECRET_KEY without sk_ prefix', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', STRIPE_SECRET_KEY: 'abc' }))
      .toThrow(/STRIPE_SECRET_KEY/)
  })

  it('rejects STRIPE_WEBHOOK_SECRET without whsec_ prefix', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', STRIPE_WEBHOOK_SECRET: 'abc' }))
      .toThrow(/STRIPE_WEBHOOK_SECRET/)
  })

  it('rejects STRIPE_PRICE_ID without price_ prefix', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', STRIPE_PRICE_ID: 'abc' }))
      .toThrow(/STRIPE_PRICE_ID/)
  })

  it('requires all 3 Stripe vars in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/STRIPE_SECRET_KEY/)
    expect(() => loadEnv({
      ...base, NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_abc',
    })).toThrow(/STRIPE_WEBHOOK_SECRET/)
    expect(() => loadEnv({
      ...base, NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
    })).toThrow(/STRIPE_PRICE_ID/)
  })
})
