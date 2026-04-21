import { describe, it, expect, vi } from 'vitest'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { generateReport } from '../../../../src/queue/workers/generate-report/generate-report.ts'

async function seedFreeGrade(store: ReturnType<typeof makeFakeStore>) {
  const grade = await store.createGrade({
    url: 'https://acme.com', domain: 'acme.com', tier: 'free', status: 'done',
    overall: 70, letter: 'C',
    scores: { recognition: 80, seo: 80, accuracy: 50, coverage: 70, citation: 70, discoverability: 60 },
  })
  await store.createScrape({
    gradeId: grade.id, rendered: false, html: '<html>Acme widgets</html>',
    text: 'Acme widgets since 1902. '.repeat(20),
    structured: {
      jsonld: [], og: {},
      meta: { title: 'Acme', description: '', canonical: 'https://acme.com', twitterCard: 'summary' },
      headings: { h1: ['Acme'], h2: [] },
      robots: null,
      sitemap: { present: true, url: '' },
      llmsTxt: { present: false, url: '' },
    } as never,
  })
  await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'claude', prompt: 'p', response: 'acme widgets', score: 80, metadata: {} })
  await store.createProbe({ gradeId: grade.id, category: 'recognition', provider: 'gpt', prompt: 'p', response: 'acme widgets', score: 70, metadata: {} })
  return grade
}

const fakeRecommender = async (_deps: never, input: { gradeId: string }) => ({
  recommendations: [1, 2, 3, 4, 5].map((rank) => ({
    gradeId: input.gradeId, rank,
    title: `r${rank}`, category: 'recognition' as const,
    impact: 4, effort: 2, rationale: 'r', how: 'h',
  })),
  attempts: 1, limited: false,
})

const makeRedis = () => ({ publish: vi.fn().mockResolvedValue(undefined) })

describe('generateReport', () => {
  it('happy path: tier flips to paid, recommendations + reports row written, events published in order', async () => {
    const store = makeFakeStore()
    const grade = await seedFreeGrade(store)
    const redis = makeRedis()
    const generic = new MockProvider({ id: 'mock', responses: () => 'ok' })

    await generateReport({
      store,
      redis: redis as never,
      providers: {
        claude: generic, gpt: generic,
        gemini: new MockProvider({ id: 'gemini', responses: () => 'acme widget' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => 'acme widget' }),
      },
      billing: null,
      mailer: new FakeMailer(),
      recommenderFn: fakeRecommender as never,
      enqueuePdfFn: async () => {},
    }, { gradeId: grade.id, sessionId: 'cs_test' })

    const updated = await store.getGrade(grade.id)
    expect(updated!.tier).toBe('paid')

    const recs = await store.listRecommendations(grade.id)
    expect(recs.length).toBeGreaterThanOrEqual(5)

    const report = await store.getReport(grade.id)
    expect(report).not.toBeNull()
    expect(report!.token).toMatch(/^[0-9a-f]{64}$/)

    const published = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string) as { type: string })
    const types = published.map((e) => e.type)
    expect(types[0]).toBe('report.started')
    expect(types).toContain('report.probe.started')
    expect(types).toContain('report.probe.completed')
    expect(types).toContain('report.recommendations.started')
    expect(types).toContain('report.recommendations.completed')
    expect(types[types.length - 1]).toBe('report.done')
  }, 60_000)

  it('tier flip is LAST: a throw before tier flip leaves tier=free', async () => {
    const store = makeFakeStore()
    const grade = await seedFreeGrade(store)
    const redis = makeRedis()
    const generic = new MockProvider({ id: 'mock', responses: () => 'ok' })
    const originalCreateReport = store.createReport.bind(store)
    store.createReport = vi.fn().mockRejectedValue(new Error('simulated'))

    await expect(generateReport({
      store, redis: redis as never,
      providers: {
        claude: generic, gpt: generic,
        gemini: new MockProvider({ id: 'gemini', responses: () => 'g' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => 'p' }),
      },
      billing: null,
      mailer: new FakeMailer(),
      recommenderFn: fakeRecommender as never,
      enqueuePdfFn: async () => {},
    }, { gradeId: grade.id, sessionId: 'cs_test' })).rejects.toThrow('simulated')

    const updated = await store.getGrade(grade.id)
    expect(updated!.tier).toBe('free')
    store.createReport = originalCreateReport
  }, 60_000)

  it('limited recommendations: grade.scores.metadata.recommendationsLimited=true', async () => {
    const store = makeFakeStore()
    const grade = await seedFreeGrade(store)
    const redis = makeRedis()
    const generic = new MockProvider({ id: 'mock', responses: () => 'ok' })
    const limitedRecommender = async () => ({ recommendations: [], attempts: 2, limited: true })

    await generateReport({
      store, redis: redis as never,
      providers: {
        claude: generic, gpt: generic,
        gemini: new MockProvider({ id: 'gemini', responses: () => 'g' }),
        perplexity: new MockProvider({ id: 'perplexity', responses: () => 'p' }),
      },
      billing: null,
      mailer: new FakeMailer(),
      recommenderFn: limitedRecommender as never,
      enqueuePdfFn: async () => {},
    }, { gradeId: grade.id, sessionId: 'cs_test' })

    const updated = await store.getGrade(grade.id)
    expect(updated!.tier).toBe('paid')
    const scores = updated!.scores as { metadata?: { recommendationsLimited?: boolean } }
    expect(scores.metadata?.recommendationsLimited).toBe(true)
  }, 60_000)
})
