import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore.issueMagicToken', () => {
  it('returns a rawToken + expiresAt, persists token row', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const { rawToken, expiresAt } = await store.issueMagicToken('user@example.com', 'cookie-1')
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/) // base64url alphabet
    expect(rawToken.length).toBeGreaterThanOrEqual(40)
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000) // > 5h from now
    expect(expiresAt.getTime()).toBeLessThan(Date.now() + 7 * 60 * 60 * 1000) // < 7h from now
  })

  it('invalidates prior unconsumed tokens for the same email', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const first = await store.issueMagicToken('user@example.com', 'cookie-1')
    const second = await store.issueMagicToken('user@example.com', 'cookie-1')
    expect(first.rawToken).not.toBe(second.rawToken)
    const rows = [...store.magicTokensMap.values()].filter((r) => r.email === 'user@example.com')
    expect(rows.length).toBe(2)
    const olderRow = rows.find((r) => r.tokenHash === store._hashForTest(first.rawToken))
    const newerRow = rows.find((r) => r.tokenHash === store._hashForTest(second.rawToken))
    expect(olderRow!.consumedAt).not.toBeNull()
    expect(newerRow!.consumedAt).toBeNull()
  })

  it('does not invalidate tokens for other emails', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('cookie-1')
    const a = await store.issueMagicToken('a@example.com', 'cookie-1')
    await store.issueMagicToken('b@example.com', 'cookie-1')
    const rowA = [...store.magicTokensMap.values()].find((r) => r.tokenHash === store._hashForTest(a.rawToken))
    expect(rowA!.consumedAt).toBeNull()
  })
})
