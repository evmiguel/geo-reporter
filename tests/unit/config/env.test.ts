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
    })
    expect(env.PUBLIC_BASE_URL).toBe('https://geo-reporter.com')
  })
})
