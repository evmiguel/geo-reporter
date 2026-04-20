import { describe, it, expect } from 'vitest'
import { loadEnv } from '../../../src/config/env.ts'

describe('env — Plan 10 deploy vars', () => {
  it('accepts optional RESEND_API_KEY as a string', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'k'.repeat(32), PUBLIC_BASE_URL: 'http://localhost',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'a', PERPLEXITY_API_KEY: 'a',
      RESEND_API_KEY: 're_test',
    })
    expect(env.RESEND_API_KEY).toBe('re_test')
  })

  it('accepts optional MAIL_FROM as a string', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'k'.repeat(32), PUBLIC_BASE_URL: 'http://localhost',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'a', PERPLEXITY_API_KEY: 'a',
      MAIL_FROM: 'noreply@send.geo.erikamiguel.com',
    })
    expect(env.MAIL_FROM).toBe('noreply@send.geo.erikamiguel.com')
  })

  it('accepts optional TRUSTED_PROXIES as a comma-separated CIDR string', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'k'.repeat(32), PUBLIC_BASE_URL: 'http://localhost',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'a', PERPLEXITY_API_KEY: 'a',
      TRUSTED_PROXIES: '10.0.0.0/8,100.64.0.0/10',
    })
    expect(env.TRUSTED_PROXIES).toBe('10.0.0.0/8,100.64.0.0/10')
  })

  it('omits all three when not set', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'k'.repeat(32), PUBLIC_BASE_URL: 'http://localhost',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'a', PERPLEXITY_API_KEY: 'a',
    })
    expect(env.RESEND_API_KEY).toBeUndefined()
    expect(env.MAIL_FROM).toBeUndefined()
    expect(env.TRUSTED_PROXIES).toBeUndefined()
  })
})
