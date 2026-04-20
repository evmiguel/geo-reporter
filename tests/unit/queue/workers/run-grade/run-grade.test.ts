import { describe, expect, it } from 'vitest'
import { runGrade } from '../../../../../src/queue/workers/run-grade/run-grade.ts'
import { MockProvider } from '../../../../../src/llm/providers/mock.ts'
import type { Job } from 'bullmq'
import type { GradeJob } from '../../../../../src/queue/queues.ts'
import type { ScrapeResult } from '../../../../../src/scraper/index.ts'
import type { Grade, GradeStore } from '../../../../../src/store/types.ts'
import type Redis from 'ioredis'
import type { GradeEvent } from '../../../../../src/queue/events.ts'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'

function makeStubRedis(): Redis & { published: { channel: string; message: string }[] } {
  const published: { channel: string; message: string }[] = []
  const stub = {
    published,
    async publish(channel: string, message: string): Promise<number> {
      published.push({ channel, message })
      return 1
    },
  }
  return stub as unknown as Redis & { published: { channel: string; message: string }[] }
}

function parseEvents(redis: { published: { channel: string; message: string }[] }, gradeId: string): GradeEvent[] {
  return redis.published
    .filter((p) => p.channel === `grade:${gradeId}`)
    .map((p) => JSON.parse(p.message) as GradeEvent)
}

function makeJob(data: GradeJob): Job<GradeJob> {
  return { data, id: 'job-1', name: 'run-grade' } as unknown as Job<GradeJob>
}

const SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: 'body text of the site with enough content for scoring signals to evaluate properly.',
  structured: {
    jsonld: [],
    og: { title: 'Acme', description: 'We sell widgets', image: 'https://acme.com/og.png' },
    meta: { title: 'Acme Widgets', description: 'We sell the best widgets on the market, made with premium materials since 1902.', canonical: 'https://acme.com', twitterCard: 'summary' },
    headings: { h1: ['Welcome to Acme'], h2: ['About us'] },
    robots: null,
    sitemap: { present: true, url: 'https://acme.com/sitemap.xml' },
    llmsTxt: { present: false, url: 'https://acme.com/llms.txt' },
  },
}

const LONG_SCRAPE: ScrapeResult = { ...SCRAPE, text: SCRAPE.text.repeat(10) }

async function seedGrade(store: GradeStore, id: string, url: string, tier: 'free' | 'paid' = 'free'): Promise<Grade> {
  const domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  return store.createGrade({ id, url, domain, tier, status: 'queued', cookie: null, userId: null })
}

// Helper that returns a single Claude that plays all roles for a happy-path free grade.
function happyClaudeAll(): MockProvider {
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

function happyGpt(): MockProvider {
  return new MockProvider({
    id: 'gpt',
    responses: (prompt) => {
      if (prompt.includes('Do NOT reference')) return 'Which brand is most popular?'
      return 'Acme is an industry standard widget producer.'
    },
  })
}

describe('runGrade', () => {
  it('free tier happy path writes 25 probes + finalizes grade', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('c1')
    const grade = await seedGrade(store, 'g-happy', 'https://acme.com')

    const deps = {
      store, redis: redis as unknown as Redis,
      providers: {
        claude: happyClaudeAll(), gpt: happyGpt(),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      },
      scrapeFn: async () => LONG_SCRAPE,
    }

    await runGrade(makeJob({ gradeId: grade.id, tier: 'free', ip: 'test-ip', cookie: 'test-cookie' }), deps)

    const updated = await store.getGrade(grade.id)
    expect(updated?.status).toBe('done')
    expect(typeof updated?.overall).toBe('number')
    expect(typeof updated?.letter).toBe('string')
    expect(updated?.scores).toBeTruthy()

    const probes = await store.listProbes(grade.id)
    // Free tier: 10 seo + 4 recognition + 2 citation + 2 discoverability + 4 coverage + 3 accuracy = 25
    expect(probes).toHaveLength(25)

    const events = parseEvents(redis, grade.id)
    expect(events[0]?.type).toBe('running')
    const scraped = events.find((e) => e.type === 'scraped')
    expect(scraped).toBeDefined()
    const done = events[events.length - 1]
    expect(done?.type).toBe('done')
  })

  it('hard-fails when scrape text is < 100 chars', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('c2')
    const grade = await seedGrade(store, 'g-short', 'https://acme.com')
    const shortScrape: ScrapeResult = { ...SCRAPE, text: 'too short' }

    const deps = {
      store, redis: redis as unknown as Redis,
      providers: {
        claude: new MockProvider({ id: 'claude', responses: () => '' }),
        gpt: new MockProvider({ id: 'gpt', responses: () => '' }),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      },
      scrapeFn: async () => shortScrape,
    }

    await expect(runGrade(makeJob({ gradeId: grade.id, tier: 'free', ip: 'test-ip', cookie: 'test-cookie' }), deps)).rejects.toThrow(/< 100 chars/)

    const updated = await store.getGrade(grade.id)
    expect(updated?.status).toBe('failed')

    const events = parseEvents(redis, grade.id)
    const failed = events.find((e) => e.type === 'failed')
    expect(failed).toBeDefined()
  })

  it('calls clearGradeArtifacts at the start of every attempt', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('c3')
    const grade = await seedGrade(store, 'g-retry', 'https://acme.com')
    const deps = {
      store, redis: redis as unknown as Redis,
      providers: {
        claude: happyClaudeAll(),
        gpt: happyGpt(),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      },
      scrapeFn: async () => LONG_SCRAPE,
    }

    await runGrade(makeJob({ gradeId: grade.id, tier: 'free', ip: 'test-ip', cookie: 'test-cookie' }), deps)
    await runGrade(makeJob({ gradeId: grade.id, tier: 'free', ip: 'test-ip', cookie: 'test-cookie' }), deps)

    expect(store.clearedFor).toEqual([grade.id, grade.id])
    const probes = await store.listProbes(grade.id)
    expect(probes).toHaveLength(25)
  })

  it('one provider failing consistently still finalizes grade', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await store.upsertCookie('c4')
    const grade = await seedGrade(store, 'g-partial', 'https://acme.com')
    const deps = {
      store, redis: redis as unknown as Redis,
      providers: {
        claude: new MockProvider({
          id: 'claude',
          responses: (p) => {
            if (p.includes('Write one specific factual question')) return 'q?'
            if (p.includes('You are verifying')) return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
            if (p.includes('You are evaluating how well')) return JSON.stringify({ probe_1: { accuracy: 80, coverage: 75, notes: '' }, probe_2: { accuracy: 75, coverage: 70, notes: '' } })
            if (p.includes('Do NOT reference')) return 'question'
            return 'Acme is the leading.'
          },
        }),
        gpt: new MockProvider({ id: 'gpt', responses: {}, failWith: 'persistent down' }),
        gemini: new MockProvider({ id: 'gemini', responses: () => '' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => '' }),
      },
      scrapeFn: async () => LONG_SCRAPE,
    }

    await runGrade(makeJob({ gradeId: grade.id, tier: 'free', ip: 'test-ip', cookie: 'test-cookie' }), deps)

    const updated = await store.getGrade(grade.id)
    expect(updated?.status).toBe('done')
    const probes = await store.listProbes(grade.id)
    const nullScored = probes.filter((p) => p.provider === 'gpt' && p.score === null)
    expect(nullScored.length).toBeGreaterThan(0)
  })
})
