import { describe, it, expect } from 'vitest'
import type { Job } from 'bullmq'
import type Redis from 'ioredis'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'
import { MockProvider } from '../../../../../src/llm/providers/mock.ts'
import type { Provider, ProviderId } from '../../../../../src/llm/providers/types.ts'
import type { RunGradeDeps } from '../../../../../src/queue/workers/run-grade/deps.ts'
import { runGrade } from '../../../../../src/queue/workers/run-grade/run-grade.ts'
import type { GradeJob } from '../../../../../src/queue/queues.ts'
import type { ScrapeResult } from '../../../../../src/scraper/index.ts'

// Redis stub that satisfies both publish (events) AND the sorted-set ops
// used by refundRateLimit.
function makeStubRedis(): Redis & { published: { channel: string; message: string }[] } {
  const published: { channel: string; message: string }[] = []
  const zsets = new Map<string, Array<{ score: number; member: string }>>()
  const stub = {
    published,
    async publish(channel: string, message: string): Promise<number> {
      published.push({ channel, message })
      return 1
    },
    async zremrangebyscore(key: string, _min: string, max: string): Promise<number> {
      const arr = zsets.get(key) ?? []
      const cutoff = Number(max)
      const kept = arr.filter((e) => e.score > cutoff)
      zsets.set(key, kept)
      return arr.length - kept.length
    },
    async zcard(key: string): Promise<number> { return (zsets.get(key) ?? []).length },
    async zadd(key: string, score: number, member: string): Promise<number> {
      const arr = zsets.get(key) ?? []
      arr.push({ score, member })
      zsets.set(key, arr)
      return 1
    },
    async zrem(key: string, member: string): Promise<number> {
      const arr = zsets.get(key) ?? []
      const kept = arr.filter((e) => e.member !== member)
      zsets.set(key, kept)
      return arr.length - kept.length
    },
    async zrange(_key: string, _start: number, _stop: number, _w?: string): Promise<string[]> {
      return []
    },
    async expire(): Promise<number> { return 1 },
  }
  return stub as unknown as Redis & { published: { channel: string; message: string }[] }
}

const LONG_SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: 'body text of the site with enough content for scoring signals to evaluate properly. '.repeat(5),
  structured: {
    jsonld: [],
    og: { title: 'Acme', description: 'We sell widgets', image: 'https://acme.test/og.png' },
    meta: { title: 'Acme Widgets', description: 'We sell the best widgets since 1902.', canonical: 'https://acme.test', twitterCard: 'summary' },
    headings: { h1: ['Welcome to Acme'], h2: ['About us'] },
    robots: null,
    sitemap: { present: true, url: 'https://acme.test/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://acme.test/llms.txt' },
  },
}

function makeFailingProvider(id: ProviderId): Provider {
  // failWith on MockProvider throws on every query — mimics an exhausted-fallback
  // terminal failure. runDiscoverabilityCategory catches and writes a probe with
  // score: null + metadata.error, which is what hasTerminalProviderFailures gates on.
  return new MockProvider({ id, responses: () => '', failWith: `${id} is terminally down` })
}

function makeHappyClaudeAll(): MockProvider {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('Write one specific factual question')) return 'When was Acme founded?'
      if (prompt.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: 'matches' })
      if (prompt.includes('You are evaluating how well')) return JSON.stringify({
        probe_1: { accuracy: 80, coverage: 75, notes: '' }, probe_2: { accuracy: 70, coverage: 65, notes: '' },
        probe_3: { accuracy: 75, coverage: 70, notes: '' }, probe_4: { accuracy: 65, coverage: 60, notes: '' },
      })
      if (prompt.includes('Do NOT reference')) return 'What is the best widget maker?'
      return 'Acme is the leading widget maker founded in 1902.'
    },
  })
}

function makeHappyGpt(): MockProvider {
  return new MockProvider({
    id: 'gpt',
    responses: (prompt) => {
      if (prompt.includes('Do NOT reference')) return 'Which brand is most popular?'
      return 'Acme is an industry standard widget producer.'
    },
  })
}

describe('runGrade canary halt', () => {
  async function setup(claudeFails: boolean, gptFails: boolean) {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('test-cookie')
    const grade = await store.createGrade({
      url: 'https://acme.test', domain: 'acme.test', tier: 'free',
      cookie: 'test-cookie', userId: null, status: 'queued',
    })
    const job = {
      data: { gradeId: grade.id, tier: 'free' as const, ip: '127.0.0.1', cookie: 'test-cookie' },
      id: 'j1', name: 'run-grade',
    } as unknown as Job<GradeJob>

    // For the OpenAI halt test we want the probe row's provider column to read
    // 'openai' (that's what hasTerminalProviderFailures checks). The production
    // OpenAIProvider exposes id 'gpt' — not 'openai' — so we cast to reach the
    // detector's gate. This is also what postgres.ts + fake-store expect.
    const gptFailing = new MockProvider({ id: 'openai' as ProviderId, responses: () => '', failWith: 'openai is terminally down' })

    const deps: RunGradeDeps = {
      store,
      redis: redis as unknown as Redis,
      providers: {
        claude: claudeFails ? makeFailingProvider('claude') : makeHappyClaudeAll(),
        gpt: gptFails ? gptFailing : makeHappyGpt(),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      },
      scrapeFn: async () => LONG_SCRAPE,
    }
    return { store, redis, grade, job, deps }
  }

  it('halts with provider_outage when Claude terminal-fails on discoverability', async () => {
    const { store, redis, grade, job, deps } = await setup(true, false)
    await runGrade(job, deps)

    const fresh = await store.getGrade(grade.id)
    expect(fresh?.status).toBe('failed')

    // No subsequent category probes were written.
    const probes = await store.listProbes(grade.id)
    const categories = new Set(probes.map((p) => p.category))
    expect(categories.has('recognition')).toBe(false)
    expect(categories.has('citation')).toBe(false)
    expect(categories.has('coverage')).toBe(false)
    expect(categories.has('accuracy')).toBe(false)

    // A failed event with kind: 'provider_outage' was published.
    const outageFailed = redis.published
      .filter((p) => p.channel === `grade:${grade.id}`)
      .map((p) => JSON.parse(p.message) as { type: string; kind?: string })
      .find((e) => e.type === 'failed')
    expect(outageFailed?.kind).toBe('provider_outage')
  })

  it('halts with provider_outage when OpenAI terminal-fails on discoverability', async () => {
    const { store, redis, grade, job, deps } = await setup(false, true)
    await runGrade(job, deps)

    const fresh = await store.getGrade(grade.id)
    expect(fresh?.status).toBe('failed')

    const outageFailed = redis.published
      .filter((p) => p.channel === `grade:${grade.id}`)
      .map((p) => JSON.parse(p.message) as { type: string; kind?: string })
      .find((e) => e.type === 'failed')
    expect(outageFailed?.kind).toBe('provider_outage')
  })

  it('does NOT halt when both Claude and OpenAI succeed on discoverability', async () => {
    const { store, grade, job, deps } = await setup(false, false)
    await runGrade(job, deps)

    const fresh = await store.getGrade(grade.id)
    expect(fresh?.status).toBe('done')

    // All 6 categories wrote at least one probe (proving we fanned out past
    // the canary).
    const probes = await store.listProbes(grade.id)
    const categories = new Set(probes.map((p) => p.category))
    for (const c of ['seo', 'discoverability', 'recognition', 'citation', 'coverage', 'accuracy'] as const) {
      expect(categories.has(c)).toBe(true)
    }
  })
})
