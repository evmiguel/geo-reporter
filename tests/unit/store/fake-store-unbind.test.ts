import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'

describe('FakeStore.unbindCookie', () => {
  it('nulls user_id but keeps cookie row', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const { rawToken } = await store.issueMagicToken('a@b.com', 'c-1')
    await store.consumeMagicToken(store._hashForTest(rawToken), 'c-1')
    const before = await store.getCookie('c-1')
    expect(before!.userId).not.toBeNull()
    await store.unbindCookie('c-1')
    const after = await store.getCookie('c-1')
    expect(after).not.toBeNull()
    expect(after!.userId).toBeNull()
  })

  it('no-op for unknown cookie', async () => {
    const store = makeFakeStore()
    await expect(store.unbindCookie('does-not-exist')).resolves.toBeUndefined()
  })
})

describe('FakeStore.getCookieWithUser', () => {
  it('returns cookie + userId + email when bound', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const { rawToken } = await store.issueMagicToken('user@example.com', 'c-1')
    await store.consumeMagicToken(store._hashForTest(rawToken), 'c-1')
    const result = await store.getCookieWithUser('c-1')
    expect(result.cookie).toBe('c-1')
    expect(result.userId).not.toBeNull()
    expect(result.email).toBe('user@example.com')
  })

  it('returns null userId + email when unbound', async () => {
    const store = makeFakeStore()
    await store.upsertCookie('c-1')
    const result = await store.getCookieWithUser('c-1')
    expect(result.cookie).toBe('c-1')
    expect(result.userId).toBeNull()
    expect(result.email).toBeNull()
  })

  it('returns all-null for nonexistent cookie', async () => {
    const store = makeFakeStore()
    const result = await store.getCookieWithUser('ghost')
    expect(result).toEqual({ cookie: 'ghost', userId: null, email: null })
  })
})
