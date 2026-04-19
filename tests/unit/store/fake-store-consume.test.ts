import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore.consumeMagicToken', () => {
  it('happy path: upserts user, binds clicking cookie, marks consumed', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-issuer')
    await store.upsertCookie('cookie-clicker')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-issuer')
    const hash = store._hashForTest(rawToken)
    const result = await store.consumeMagicToken(hash, 'cookie-clicker')
    if (!result.ok) throw new Error('expected ok')
    expect(result.email).toBe('user@example.com')
    expect(result.userId).toMatch(/^[0-9a-f-]+$/)
    const clicking = await store.getCookie('cookie-clicker')
    const issuing = await store.getCookie('cookie-issuer')
    expect(clicking!.userId).toBe(result.userId)
    expect(issuing!.userId).toBeNull()
  })

  it('returns ok:false for unknown hash', async () => {
    const store = makeFakeStore()
    const result = await store.consumeMagicToken('nonexistent-hash', 'cookie')
    expect(result).toEqual({ ok: false })
  })

  it('returns ok:false on second consume of same token', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-1')
    const hash = store._hashForTest(rawToken)
    const first = await store.consumeMagicToken(hash, 'cookie-1')
    expect(first.ok).toBe(true)
    const second = await store.consumeMagicToken(hash, 'cookie-1')
    expect(second).toEqual({ ok: false })
  })

  it('returns ok:false for expired token', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'cookie-1')
    const hash = store._hashForTest(rawToken)
    for (const [id, row] of store.magicTokensMap.entries()) {
      if (row.tokenHash === hash) {
        store.magicTokensMap.set(id, { ...row, expiresAt: new Date(Date.now() - 1000) })
      }
    }
    const result = await store.consumeMagicToken(hash, 'cookie-1')
    expect(result).toEqual({ ok: false })
  })

  it('idempotent user upsert: second verify for same email reuses user', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-a')
    await store.upsertCookie('cookie-b')
    const first = await store.issueMagicToken('user@example.com', 'cookie-a')
    const firstResult = await store.consumeMagicToken(store._hashForTest(first.rawToken), 'cookie-a')
    const second = await store.issueMagicToken('user@example.com', 'cookie-b')
    const secondResult = await store.consumeMagicToken(store._hashForTest(second.rawToken), 'cookie-b')
    if (!firstResult.ok || !secondResult.ok) throw new Error('expected ok')
    expect(firstResult.userId).toBe(secondResult.userId)
  })
})
