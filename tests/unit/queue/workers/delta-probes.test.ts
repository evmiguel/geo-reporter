import { describe, it, expect, vi } from 'vitest'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { runDeltaProbes } from '../../../../src/queue/workers/generate-report/probes.ts'
import type { ScrapeResult } from '../../../../src/scraper/types.ts'
import type { GradeEvent } from '../../../../src/queue/events.ts'

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

describe('runDeltaProbes', () => {
  it('adds probe rows for Gemini + Perplexity + publishes report.probe.* events', async () => {
    const store = makeFakeStore()
    const grade = await store.createGrade({
      url: 'https://acme.com',
      domain: 'acme.com',
      tier: 'free',
    })
    // Pre-seed Claude + GPT probes so we can assert "delta only" adds rows with gemini/perplexity
    await store.createProbe({
      gradeId: grade.id,
      category: 'recognition',
      provider: 'claude',
      prompt: 'p',
      response: 'r',
      score: 80,
      metadata: {},
    })
    await store.createProbe({
      gradeId: grade.id,
      category: 'recognition',
      provider: 'gpt',
      prompt: 'p',
      response: 'r',
      score: 70,
      metadata: {},
    })

    // Gemini & Perplexity return enough text for heuristic + self-gen flows; they're
    // also called in the coverage flow. For coverage, the judge response must mention
    // all 4 probe keys. For discoverability, the first call is a generator prompt
    // (contains "Do NOT reference"); subsequent calls are the self-asked question.
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
    // Claude is used as generator/verifier/judge. Verifier returns JSON;
    // generator returns a question; judge returns JSON keyed by probe_N.
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

    const events: GradeEvent[] = []
    const publishEvent = vi.fn().mockImplementation(async (ev: GradeEvent) => {
      events.push(ev)
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
        publishEvent,
      },
      { grade, scrape: FIXTURE_SCRAPE },
    )

    const probes = await store.listProbes(grade.id)
    const deltaRows = probes.filter(
      (p) => p.provider === 'gemini' || p.provider === 'perplexity',
    )
    expect(deltaRows.length).toBeGreaterThan(0)

    // Pre-seeded Claude + GPT rows are untouched
    expect(probes.filter((p) => p.provider === 'claude').length).toBeGreaterThanOrEqual(1)
    expect(probes.filter((p) => p.provider === 'gpt').length).toBeGreaterThanOrEqual(1)

    // Accuracy is intentionally skipped during delta probes (would otherwise
    // regenerate the question and mix answers across two different questions).
    // The paid report reuses the free-tier 2-provider accuracy score as-is.
    const deltaAccuracyRows = deltaRows.filter((p) => p.category === 'accuracy')
    expect(deltaAccuracyRows).toHaveLength(0)

    // report.probe.* events were published
    expect(events.some((e) => e.type === 'report.probe.started')).toBe(true)
    expect(events.some((e) => e.type === 'report.probe.completed')).toBe(true)

    // No plain probe.* events should leak out through publishEvent
    expect(events.some((e) => e.type === 'probe.started')).toBe(false)
    expect(events.some((e) => e.type === 'probe.completed')).toBe(false)
  }, 30_000)
})
