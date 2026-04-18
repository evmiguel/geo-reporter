import { describe, expect, it } from 'vitest'
import { collapseToCategoryScore } from '../../../../../src/queue/workers/run-grade/categories.ts'
import type Redis from 'ioredis'
import type { GradeEvent } from '../../../../../src/queue/events.ts'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'
import type { Grade } from '../../../../../src/store/types.ts'

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

describe('collapseToCategoryScore', () => {
  it('returns rounded mean for all-number input', () => {
    expect(collapseToCategoryScore([80, 90, 70])).toBe(80)
  })
  it('ignores nulls and averages the rest', () => {
    expect(collapseToCategoryScore([null, 80, null, 100])).toBe(90)
  })
  it('returns null when all entries are null', () => {
    expect(collapseToCategoryScore([null, null])).toBeNull()
  })
  it('returns null for empty array', () => {
    expect(collapseToCategoryScore([])).toBeNull()
  })
  it('rounds .5 half away from zero (JS Math.round)', () => {
    expect(collapseToCategoryScore([50, 51])).toBe(51)
  })
})

// Task 5: SEO Category Tests
import { runSeoCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'
import type { ScrapeResult } from '../../../../../src/scraper/index.ts'

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

describe('runSeoCategory', () => {
  it('writes 10 probe rows (one per signal), all with provider=null', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const score = await runSeoCategory({ gradeId: 'g1', scrape: SCRAPE, deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const seoProbes = store.probes.filter((p) => p.category === 'seo')
    expect(seoProbes).toHaveLength(10)
    expect(seoProbes.every((p) => p.provider === null)).toBe(true)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('emits probe.completed per signal + category.completed', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    await runSeoCategory({ gradeId: 'g1', scrape: SCRAPE, deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const events = parseEvents(redis, 'g1')
    const probeCompletions = events.filter((e) => e.type === 'probe.completed' && e.category === 'seo')
    const cat = events.find((e) => e.type === 'category.completed' && e.category === 'seo')
    expect(probeCompletions).toHaveLength(10)
    expect(cat).toBeDefined()
  })

  it('returns the score from evaluateSeo (not collapsed per-signal)', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const score = await runSeoCategory({ gradeId: 'g1', scrape: SCRAPE, deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })
    expect(score).toBeGreaterThan(0)
  })
})

// Task 6: Recognition + Citation Tests
import { runRecognitionCategory, runCitationCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'
import { MockProvider } from '../../../../../src/llm/providers/mock.ts'

const GRADE: Grade = {
  id: 'g-rec', url: 'https://stripe.com', domain: 'stripe.com', tier: 'free',
  cookie: null, userId: null, status: 'running',
  overall: null, letter: null, scores: null,
  createdAt: new Date(), updatedAt: new Date(),
}

describe('runRecognitionCategory', () => {
  it('runs 2 prompts × N providers and writes 2N probe rows', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Stripe is a leading payment processor founded in 2010, used by millions of businesses worldwide.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Stripe is a payment service.' })
    const score = await runRecognitionCategory({ gradeId: 'g-rec', grade: GRADE, scrape: SCRAPE, probers: [claude, gpt], deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const rows = store.probes.filter((p) => p.category === 'recognition')
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.provider).sort()).toEqual(['claude', 'claude', 'gpt', 'gpt'])
    expect(score).not.toBeNull()
  })

  it('records error in metadata when a provider throws; score is null for that probe', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Stripe is a leading payment processor.' })
    const broken = new MockProvider({ id: 'gpt', responses: {}, failWith: 'rate limit' })
    await runRecognitionCategory({ gradeId: 'g-rec', grade: GRADE, scrape: SCRAPE, probers: [claude, broken], deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const brokenRows = store.probes.filter((p) => p.category === 'recognition' && p.provider === 'gpt')
    expect(brokenRows).toHaveLength(2)
    expect(brokenRows.every((r) => r.score === null)).toBe(true)
    expect(brokenRows.every((r) => (r.metadata as { error?: string }).error === 'rate limit')).toBe(true)
  })

  it('returns null score when every provider fails for every prompt', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const a = new MockProvider({ id: 'claude', responses: {}, failWith: 'down' })
    const b = new MockProvider({ id: 'gpt', responses: {}, failWith: 'down' })
    const score = await runRecognitionCategory({ gradeId: 'g-rec', grade: GRADE, scrape: SCRAPE, probers: [a, b], deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })
    expect(score).toBeNull()
  })

  it('emits category.completed with the collapsed score', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Stripe is the leading payment processor used worldwide by millions, founded in 2010.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Stripe is a leading payment processor used globally.' })
    const score = await runRecognitionCategory({ gradeId: 'g-rec', grade: GRADE, scrape: SCRAPE, probers: [claude, gpt], deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const events = parseEvents(redis, 'g-rec')
    const cat = events.find((e) => e.type === 'category.completed' && e.category === 'recognition')
    expect(cat).toBeDefined()
    if (cat?.type === 'category.completed') expect(cat.score).toBe(score)
  })
})

describe('runCitationCategory', () => {
  it('runs 1 prompt per provider and writes N probe rows', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Visit https://stripe.com' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'See stripe.com' })
    const score = await runCitationCategory({ gradeId: 'g-cit', grade: { ...GRADE, id: 'g-cit', url: 'https://stripe.com' }, scrape: SCRAPE, probers: [claude, gpt], deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const rows = store.probes.filter((p) => p.category === 'citation')
    expect(rows).toHaveLength(2)
    expect(score).toBe(75) // round((100 + 50) / 2)
  })

  it('records error on provider failure', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const broken = new MockProvider({ id: 'claude', responses: {}, failWith: 'timeout' })
    await runCitationCategory({ gradeId: 'g-cit', grade: { ...GRADE, id: 'g-cit' }, scrape: SCRAPE, probers: [broken], deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const rows = store.probes.filter((p) => p.category === 'citation')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.score).toBeNull()
    expect((rows[0]?.metadata as { error?: string }).error).toBe('timeout')
  })
})

// Task 7: Discoverability Tests
import { runDiscoverabilityCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'

describe('runDiscoverabilityCategory', () => {
  it('runs self-gen flow per provider and writes N probe rows', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({
      id: 'claude',
      responses: (prompt) => prompt.includes('Do NOT reference')
        ? 'What is the best payment processor?'
        : 'Stripe is the leading payment processor used worldwide.',
    })
    const gpt = new MockProvider({
      id: 'gpt',
      responses: (prompt) => prompt.includes('Do NOT reference')
        ? 'Which payment platform is the industry standard?'
        : 'Stripe is the industry standard for payments.',
    })
    const score = await runDiscoverabilityCategory({ gradeId: 'g-disc', grade: { ...GRADE, id: 'g-disc' }, scrape: SCRAPE, probers: [claude, gpt], deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })

    const rows = store.probes.filter((p) => p.category === 'discoverability')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => (r.metadata as { generator?: unknown }).generator !== undefined)).toBe(true)
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('records error on provider failure', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const broken = new MockProvider({ id: 'claude', responses: {}, failWith: 'down' })
    const score = await runDiscoverabilityCategory({ gradeId: 'g-disc', grade: { ...GRADE, id: 'g-disc' }, scrape: SCRAPE, probers: [broken], deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE } })
    expect(score).toBeNull()
    const rows = store.probes.filter((p) => p.category === 'discoverability')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.score).toBeNull()
    expect((rows[0]?.metadata as { error?: string }).error).toBe('down')
  })
})

// Task 8: Coverage Tests
import { runCoverageCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'

describe('runCoverageCategory', () => {
  it('writes 2N probe rows with per-probe judge scores', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Acme sells widgets to construction firms.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Acme provides industrial widgets.' })
    const judge = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({
        probe_1: { accuracy: 80, coverage: 70, notes: 'c' },
        probe_2: { accuracy: 60, coverage: 55, notes: 'g' },
        probe_3: { accuracy: 75, coverage: 70, notes: 'c2' },
        probe_4: { accuracy: 65, coverage: 60, notes: 'g2' },
      }),
    })
    const score = await runCoverageCategory({
      gradeId: 'g-cov', grade: { ...GRADE, id: 'g-cov' }, scrape: SCRAPE, probers: [claude, gpt], judge,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE },
    })

    const rows = store.probes.filter((p) => p.category === 'coverage')
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(typeof row.score).toBe('number')
      const md = row.metadata as { judgeAccuracy: number; judgeCoverage: number; judgeNotes: string; judgeDegraded: boolean }
      expect(md.judgeAccuracy).toBeGreaterThanOrEqual(0)
      expect(md.judgeDegraded).toBe(false)
    }
    expect(score).not.toBeNull()
  })

  it('handles judge-degraded path (heuristic fallback)', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Acme sells widgets.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Acme makes widgets.' })
    const judge = new MockProvider({ id: 'claude', responses: () => 'not json at all, even after retry' })

    const score = await runCoverageCategory({
      gradeId: 'g-cov-d', grade: { ...GRADE, id: 'g-cov-d' }, scrape: SCRAPE, probers: [claude, gpt], judge,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE },
    })

    const rows = store.probes.filter((p) => p.category === 'coverage')
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect((row.metadata as { judgeDegraded: boolean }).judgeDegraded).toBe(true)
    }
    expect(score).not.toBeNull()
  })

  it('records per-probe error when a prober fails', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'ok' })
    const broken = new MockProvider({ id: 'gpt', responses: {}, failWith: 'rate limit' })
    const judge = new MockProvider({ id: 'claude', responses: () => JSON.stringify({ probe_1: { accuracy: 80, coverage: 70, notes: '' }, probe_2: { accuracy: 75, coverage: 65, notes: '' } }) })

    await runCoverageCategory({
      gradeId: 'g-cov-f', grade: { ...GRADE, id: 'g-cov-f' }, scrape: SCRAPE, probers: [claude, broken], judge,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => SCRAPE },
    })

    const brokenRows = store.probes.filter((p) => p.category === 'coverage' && p.provider === 'gpt')
    expect(brokenRows).toHaveLength(2)
    expect(brokenRows.every((r) => r.score === null)).toBe(true)
    expect(brokenRows.every((r) => (r.metadata as { error?: string }).error === 'rate limit')).toBe(true)
  })
})

// Task 9: Accuracy Tests
import { runAccuracyCategory } from '../../../../../src/queue/workers/run-grade/categories.ts'

const LONG_SCRAPE: ScrapeResult = { ...SCRAPE, text: SCRAPE.text.repeat(10) }

describe('runAccuracyCategory', () => {
  it('happy path: writes 1 generator row + N answer rows', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'Acme was founded in 1902.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Acme was founded in 1902.' })
    const generator = new MockProvider({ id: 'claude', responses: () => 'When was Acme founded?' })
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: true, confidence: 0.95, rationale: 'matches scrape' }),
    })

    const score = await runAccuracyCategory({
      gradeId: 'g-acc', grade: { ...GRADE, id: 'g-acc' }, scrape: LONG_SCRAPE,
      probers: [claude, gpt], generator, verifier,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => LONG_SCRAPE },
    })

    const rows = store.probes.filter((p) => p.category === 'accuracy')
    expect(rows).toHaveLength(3)
    const genRow = rows.find((r) => (r.metadata as { role?: string }).role === 'generator')
    const verifyRows = rows.filter((r) => (r.metadata as { role?: string }).role === 'verify')
    expect(genRow).toBeDefined()
    expect(genRow?.score).toBeNull()
    expect(verifyRows).toHaveLength(2)
    expect(verifyRows.every((r) => r.score === 100)).toBe(true)
    expect(score).toBe(100)
    const generatorId = genRow!.id
    expect(verifyRows.every((r) => (r.metadata as { generatorProbeId?: string }).generatorProbeId === generatorId)).toBe(true)
  })

  it('insufficient_scrape path: writes a skipped placeholder row, returns null', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const sparseScrape: ScrapeResult = { ...SCRAPE, text: 'too short' }
    const generator = new MockProvider({ id: 'claude', responses: () => 'never called' })
    const verifier = new MockProvider({ id: 'claude', responses: () => 'never called' })
    const score = await runAccuracyCategory({
      gradeId: 'g-acc-s', grade: { ...GRADE, id: 'g-acc-s' }, scrape: sparseScrape,
      probers: [new MockProvider({ id: 'claude', responses: () => 'nope' })], generator, verifier,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => sparseScrape },
    })

    expect(score).toBeNull()
    const rows = store.probes.filter((p) => p.category === 'accuracy')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.provider).toBeNull()
    expect((rows[0]?.metadata as { role?: string; reason?: string }).role).toBe('skipped')
    expect((rows[0]?.metadata as { reason?: string }).reason).toBe('insufficient_scrape')
  })

  it('all_null path: writes skipped row when every verifier returns correct:null', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const claude = new MockProvider({ id: 'claude', responses: () => 'vague answer' })
    const generator = new MockProvider({ id: 'claude', responses: () => 'What is the best year?' })
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: null, confidence: 0.1, rationale: 'scrape does not cover' }),
    })

    const score = await runAccuracyCategory({
      gradeId: 'g-acc-n', grade: { ...GRADE, id: 'g-acc-n' }, scrape: LONG_SCRAPE,
      probers: [claude], generator, verifier,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => LONG_SCRAPE },
    })

    expect(score).toBeNull()
    const rows = store.probes.filter((p) => p.category === 'accuracy')
    const skipped = rows.find((r) => (r.metadata as { role?: string }).role === 'skipped')
    expect(skipped).toBeDefined()
    expect((skipped?.metadata as { reason?: string }).reason).toBe('all_null')
  })

  it('generator failure: writes skipped row, returns null', async () => {
    const store = makeFakeStore()
    const redis = makeStubRedis()
    const generator = new MockProvider({ id: 'claude', responses: {}, failWith: 'generator down' })
    const verifier = new MockProvider({ id: 'claude', responses: () => 'never' })
    const score = await runAccuracyCategory({
      gradeId: 'g-acc-gf', grade: { ...GRADE, id: 'g-acc-gf' }, scrape: LONG_SCRAPE,
      probers: [new MockProvider({ id: 'claude', responses: () => 'x' })], generator, verifier,
      deps: { store, redis, providers: {} as never, scrapeFn: async () => LONG_SCRAPE },
    })

    expect(score).toBeNull()
    const rows = store.probes.filter((p) => p.category === 'accuracy')
    const skipped = rows.find((r) => (r.metadata as { role?: string }).role === 'skipped')
    expect(skipped).toBeDefined()
    expect((skipped?.metadata as { reason?: string }).reason).toBe('generator_failed')
  })
})
