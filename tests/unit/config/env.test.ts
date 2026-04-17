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
