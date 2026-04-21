import type Redis from 'ioredis'

export interface StubRedis extends Redis {
  published: { channel: string; message: string }[]
}

// Minimal Redis stub that supports the sorted-set ops used by peekBucket/addToBucket
// plus a trivial `publish` sink for SSE events. Kept intentionally tiny — unit tests
// that need full Redis semantics should use testcontainers via the integration suite.
export function makeStubRedis(): StubRedis {
  const zsets = new Map<string, Array<{ score: number; member: string }>>()
  const published: { channel: string; message: string }[] = []
  return {
    published,
    async publish(channel: string, message: string): Promise<number> {
      published.push({ channel, message })
      return 1
    },
    async zremrangebyscore(key: string, _min: string, max: string) {
      const arr = zsets.get(key) ?? []
      const cutoff = Number(max)
      const kept = arr.filter((e) => e.score > cutoff)
      zsets.set(key, kept)
      return arr.length - kept.length
    },
    async zcard(key: string) { return (zsets.get(key) ?? []).length },
    async zadd(key: string, score: number, member: string) {
      const arr = zsets.get(key) ?? []
      arr.push({ score, member })
      zsets.set(key, arr)
      return 1
    },
    async zrem(key: string, member: string) {
      const arr = zsets.get(key) ?? []
      const kept = arr.filter((e) => e.member !== member)
      zsets.set(key, kept)
      return arr.length - kept.length
    },
    async zrange(key: string, start: number, stop: number, _w?: string) {
      const arr = [...(zsets.get(key) ?? [])].sort((a, b) => a.score - b.score)
      const slice = arr.slice(start, stop + 1)
      const flat: string[] = []
      for (const e of slice) { flat.push(e.member, String(e.score)) }
      return flat
    },
    async expire() { return 1 },
  } as unknown as StubRedis
}
