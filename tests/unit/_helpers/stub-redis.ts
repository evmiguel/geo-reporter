import type Redis from 'ioredis'

// Minimal Redis stub that supports the sorted-set ops used by peekBucket/addToBucket.
// Kept intentionally tiny — unit tests that need full Redis semantics should use
// testcontainers via the integration suite.
export function makeStubRedis(): Redis {
  const zsets = new Map<string, Array<{ score: number; member: string }>>()
  return {
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
    async zrange(key: string, start: number, stop: number, _w?: string) {
      const arr = [...(zsets.get(key) ?? [])].sort((a, b) => a.score - b.score)
      const slice = arr.slice(start, stop + 1)
      const flat: string[] = []
      for (const e of slice) { flat.push(e.member, String(e.score)) }
      return flat
    },
    async expire() { return 1 },
  } as unknown as Redis
}
