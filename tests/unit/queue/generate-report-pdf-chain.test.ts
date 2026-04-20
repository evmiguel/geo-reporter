import { describe, it, expect, vi } from 'vitest'
import { generateReport } from '../../../src/queue/workers/generate-report/generate-report.ts'
import { MockProvider } from '../../../src/llm/providers/index.ts'
import type { ScrapeResult } from '../../../src/scraper/types.ts'

const FIXTURE_STRUCTURED: ScrapeResult['structured'] = {
  jsonld: [],
  og: {},
  meta: {
    title: 'Acme',
    description: '',
    canonical: 'https://acme.com',
    twitterCard: 'summary',
  },
  headings: { h1: ['Acme'], h2: [] },
  robots: null,
  sitemap: { present: true, url: '' },
  llmsTxt: { present: false, url: '' },
}

function makeProviders(): {
  claude: MockProvider
  gpt: MockProvider
  gemini: MockProvider
  perplexity: MockProvider
} {
  // Judge JSON for coverage probes — keys are probe_1..probe_N; we map a generous range.
  const judgeJson = (): string => {
    const obj: Record<string, { accuracy: number; coverage: number; notes: string }> = {}
    for (let i = 1; i <= 20; i++) {
      obj[`probe_${i}`] = { accuracy: 80, coverage: 70, notes: 'ok' }
    }
    return JSON.stringify(obj)
  }
  const claude = new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      if (prompt.includes('Below is content scraped from a company website')) return 'When was Acme founded?'
      if (prompt.includes('You are verifying a factual answer')) {
        return JSON.stringify({ correct: true, confidence: 0.9, rationale: '' })
      }
      if (prompt.includes('You are evaluating how well')) return judgeJson()
      if (prompt.includes('For each probe response below')) return judgeJson()
      return 'Acme widgets — leading widget maker.'
    },
  })
  const gemini = new MockProvider({
    id: 'gemini',
    responses: (prompt) =>
      prompt.includes('Do NOT reference') ? 'What is the best widget maker?' : 'Acme widgets, family-owned. See https://acme.com',
  })
  const perplexity = new MockProvider({
    id: 'perplexity',
    responses: (prompt) =>
      prompt.includes('Do NOT reference') ? 'Which company makes premium widgets?' : 'Acme provides widgets since 1902. https://acme.com',
  })
  const gpt = new MockProvider({ id: 'gpt', responses: () => 'Acme widget company' })
  return { claude, gpt, gemini, perplexity }
}

function makeStoreStub(opts: {
  reportId: string
  gradeId: string
  initPdfMock: (reportId: string) => Promise<void>
}): unknown {
  const probes: unknown[] = []
  let probeSeq = 0
  return {
    getGrade: async () => ({
      id: opts.gradeId,
      tier: 'free',
      status: 'done',
      url: 'https://acme.com',
      domain: 'acme.com',
      scores: {},
    }),
    getScrape: async () => ({
      id: 'scrape-1',
      rendered: false,
      html: '<html></html>',
      text: 'Acme widgets since 1902. Family-owned.'.repeat(20),
      structured: FIXTURE_STRUCTURED,
    }),
    listProbes: async () => probes,
    createRecommendations: async () => {},
    createProbe: async (input: Record<string, unknown>) => {
      probeSeq += 1
      const row = { id: `probe_${probeSeq}`, ...input }
      probes.push(row)
      return row
    },
    createReport: async (input: { gradeId: string; token: string }) => ({
      id: opts.reportId,
      ...input,
      createdAt: new Date(),
    }),
    initReportPdfRow: opts.initPdfMock,
    updateGrade: async () => {},
  }
}

describe('generate-report chains render-pdf', () => {
  it('calls initReportPdfRow and enqueuePdf after reports row is written', async () => {
    const enqueuePdfMock = vi.fn(async () => {})
    const initPdfMock = vi.fn(async () => {})

    const deps = {
      store: makeStoreStub({ reportId: 'r1', gradeId: 'g1', initPdfMock }),
      redis: { publish: async () => 0 },
      providers: makeProviders(),
      recommenderFn: async () => ({ recommendations: [], limited: false }),
      enqueuePdfFn: enqueuePdfMock,
    } as never

    await generateReport(deps, { gradeId: 'g1', sessionId: 'sess' })

    expect(initPdfMock).toHaveBeenCalledWith('r1')
    expect(enqueuePdfMock).toHaveBeenCalledWith({ reportId: 'r1' })
  })

  it('still succeeds if enqueuePdf throws', async () => {
    const initPdfMock = vi.fn(async () => {})
    const deps = {
      store: makeStoreStub({ reportId: 'r2', gradeId: 'g2', initPdfMock }),
      redis: { publish: async () => 0 },
      providers: makeProviders(),
      recommenderFn: async () => ({ recommendations: [], limited: false }),
      enqueuePdfFn: async () => {
        throw new Error('queue is down')
      },
    } as never

    await expect(generateReport(deps, { gradeId: 'g2', sessionId: 'sess' })).resolves.not.toThrow()
  })
})
