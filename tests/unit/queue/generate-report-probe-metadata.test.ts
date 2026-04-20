import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../_helpers/fake-store.ts'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { runDeltaProbes } from '../../../src/queue/workers/generate-report/probes.ts'
import type { ScrapeResult } from '../../../src/scraper/types.ts'
import type { GradeEvent } from '../../../src/queue/events.ts'

const FIXTURE_SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: 'Acme widgets since 1902. Family-owned.'.repeat(20),
  structured: {
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
  },
}

function judgeJson(): string {
  return JSON.stringify({
    probe_1: { accuracy: 80, coverage: 70, notes: 'ok' },
    probe_2: { accuracy: 75, coverage: 65, notes: 'ok' },
    probe_3: { accuracy: 80, coverage: 70, notes: 'ok' },
    probe_4: { accuracy: 75, coverage: 65, notes: 'ok' },
  })
}

describe('generate-report delta probes include metadata.model', () => {
  it('Gemini + Perplexity probes have metadata.model set', async () => {
    const store = makeFakeStore()
    const grade = await store.createGrade({
      url: 'https://acme.com',
      domain: 'acme.com',
      tier: 'free',
    })

    const gemini = new MockProvider({
      id: 'gemini',
      responses: (prompt) =>
        prompt.includes('Do NOT reference')
          ? 'What is the best widget maker?'
          : 'acme is a widget maker and makes widgets since 1902. Visit https://acme.com',
    })
    const perplexity = new MockProvider({
      id: 'perplexity',
      responses: (prompt) =>
        prompt.includes('Do NOT reference')
          ? 'Which company makes premium widgets?'
          : 'acme provides widgets. See https://acme.com',
    })
    const claude = new MockProvider({
      id: 'claude',
      responses: (prompt) => {
        if (prompt.includes('Below is content scraped from a company website')) {
          return 'When was Acme founded?'
        }
        if (prompt.includes('You are verifying a factual answer')) {
          return JSON.stringify({ correct: true, confidence: 0.9, rationale: 'matches' })
        }
        if (prompt.includes('You are evaluating how well')) {
          return judgeJson()
        }
        return 'claude fallback'
      },
    })

    await runDeltaProbes(
      {
        store,
        providers: {
          gemini,
          perplexity,
          claudeForJudge: claude,
          generator: claude,
          verifier: claude,
        },
        publishEvent: async (_ev: GradeEvent): Promise<void> => {},
      },
      { grade, scrape: FIXTURE_SCRAPE },
    )

    const probes = await store.listProbes(grade.id)
    const withProvider = probes.filter((p) => p.provider !== null)
    expect(withProvider.length).toBeGreaterThan(0)
    for (const probe of withProvider) {
      const model = (probe.metadata as { model?: string }).model
      expect(
        model,
        `probe for ${probe.provider} (${probe.category}) should have metadata.model`,
      ).toBeDefined()
    }
  }, 30_000)
})
