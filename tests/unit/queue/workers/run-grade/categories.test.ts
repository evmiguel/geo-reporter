import { describe, expect, it } from 'vitest'
import { collapseToCategoryScore } from '../../../../../src/queue/workers/run-grade/categories.ts'
import type { GradeStore, Grade, Probe, Scrape, NewGrade, NewProbe, NewScrape, GradeUpdate, User, Cookie, Recommendation, NewRecommendation, Report, NewReport } from '../../../../../src/store/types.ts'
import type Redis from 'ioredis'
import type { GradeEvent } from '../../../../../src/queue/events.ts'

function makeFakeStore(): GradeStore & {
  gradesMap: Map<string, Grade>
  scrapesMap: Map<string, Scrape>
  probes: Probe[]
  clearedFor: string[]
} {
  const gradesMap = new Map<string, Grade>()
  const scrapesMap = new Map<string, Scrape>()
  const probes: Probe[] = []
  const clearedFor: string[] = []

  return {
    gradesMap, scrapesMap, probes, clearedFor,
    async createGrade(input: NewGrade): Promise<Grade> {
      const id = input.id ?? crypto.randomUUID()
      const now = new Date()
      const g: Grade = {
        id, url: input.url, domain: input.domain, tier: input.tier,
        cookie: input.cookie ?? null, userId: input.userId ?? null,
        status: input.status ?? 'queued',
        overall: input.overall ?? null, letter: input.letter ?? null, scores: input.scores ?? null,
        createdAt: now, updatedAt: now,
      }
      gradesMap.set(id, g)
      return g
    },
    async getGrade(id: string): Promise<Grade | null> { return gradesMap.get(id) ?? null },
    async updateGrade(id: string, patch: GradeUpdate): Promise<void> {
      const g = gradesMap.get(id)
      if (!g) return
      gradesMap.set(id, { ...g, ...patch, updatedAt: new Date() })
    },
    async createProbe(input: NewProbe): Promise<Probe> {
      const p: Probe = {
        id: crypto.randomUUID(), gradeId: input.gradeId, category: input.category,
        provider: input.provider ?? null, prompt: input.prompt, response: input.response,
        score: input.score ?? null, metadata: input.metadata ?? {}, createdAt: new Date(),
      }
      probes.push(p)
      return p
    },
    async listProbes(gradeId: string): Promise<Probe[]> { return probes.filter((p) => p.gradeId === gradeId) },
    async createScrape(input: NewScrape): Promise<Scrape> {
      const s: Scrape = {
        id: crypto.randomUUID(), gradeId: input.gradeId, rendered: input.rendered ?? false,
        html: input.html, text: input.text, structured: input.structured,
        fetchedAt: input.fetchedAt ?? new Date(),
      }
      scrapesMap.set(input.gradeId, s)
      return s
    },
    async getScrape(gradeId: string): Promise<Scrape | null> { return scrapesMap.get(gradeId) ?? null },
    async clearGradeArtifacts(gradeId: string): Promise<void> {
      clearedFor.push(gradeId)
      scrapesMap.delete(gradeId)
      for (let i = probes.length - 1; i >= 0; i--) if (probes[i]?.gradeId === gradeId) probes.splice(i, 1)
    },
    async upsertUser(_email: string): Promise<User> { return { id: crypto.randomUUID(), email: _email, createdAt: new Date() } },
    async upsertCookie(cookie: string, userId?: string): Promise<Cookie> { return { cookie, userId: userId ?? null, createdAt: new Date() } },
    async createRecommendations(_rows: NewRecommendation[]): Promise<void> {},
    async listRecommendations(_gradeId: string): Promise<Recommendation[]> { return [] },
    async createReport(input: NewReport): Promise<Report> { return { id: crypto.randomUUID(), gradeId: input.gradeId, token: input.token, createdAt: new Date() } },
    async getReport(_gradeId: string): Promise<Report | null> { return null },
  }
}

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
