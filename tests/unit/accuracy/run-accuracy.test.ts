import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { runAccuracy } from '../../../src/accuracy/index.ts'
import type { ScrapeResult } from '../../../src/scraper/index.ts'

const URL = 'https://acme.com'
const SCRAPE: ScrapeResult = {
  rendered: false,
  html: '<html></html>',
  text: 'Acme was founded in 1902 in Springfield. We make industrial widgets. Family-owned for four generations, used across North America.',
  structured: {
    jsonld: [], og: {}, meta: { title: 'Acme', description: 'Widgets since 1902.' },
    headings: { h1: ['Welcome'], h2: [] },
    robots: null,
    sitemap: { present: false, url: '' }, llmsTxt: { present: false, url: '' },
  },
}

const SPARSE_SCRAPE: ScrapeResult = { ...SCRAPE, text: 'too short' }

const GEN = new MockProvider({ id: 'gpt', responses: () => 'When was Acme founded?' })

function makeVerifier(table: Record<string, { correct: boolean | null; confidence?: number; rationale?: string }>) {
  return new MockProvider({
    id: 'claude',
    responses: (prompt) => {
      for (const [providerMarker, v] of Object.entries(table)) {
        if (prompt.includes(`Provider: ${providerMarker}`)) {
          return JSON.stringify({ correct: v.correct, confidence: v.confidence ?? 0.9, rationale: v.rationale ?? '' })
        }
      }
      throw new Error('verifier: unrecognized provider')
    },
  })
}

describe('runAccuracy', () => {
  it('returns insufficient_scrape for text < 500 chars without making any LLM calls', async () => {
    const result = await runAccuracy({
      generator: GEN,
      verifier: makeVerifier({}),
      probers: [],
      url: URL,
      scrape: SPARSE_SCRAPE,
    })
    expect(result.reason).toBe('insufficient_scrape')
    expect(result.score).toBeNull()
    expect(result.generator).toBeNull()
    expect(result.probes).toEqual([])
    expect(GEN.calls.length).toBe(0)
  })

  it('full happy path with 2 probers — all correct → score 100', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const claude = new MockProvider({ id: 'claude', responses: () => 'Founded in 1902.' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'Founded in 1902.' })
    const verifier = makeVerifier({ claude: { correct: true }, gpt: { correct: true } })
    const result = await runAccuracy({
      generator: GEN, verifier, probers: [claude, gpt], url: URL, scrape: longScrape,
    })
    expect(result.reason).toBe('ok')
    expect(result.score).toBe(100)
    expect(result.valid).toBe(2)
    expect(result.correct).toBe(2)
    expect(result.probes).toHaveLength(2)
    expect(result.verifications).toHaveLength(2)
  })

  it('4-prober paid tier with mixed correct/false/null gives correct/valid math', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const probers = [
      new MockProvider({ id: 'claude', responses: () => 'a1' }),
      new MockProvider({ id: 'gpt', responses: () => 'a2' }),
      new MockProvider({ id: 'gemini', responses: () => 'a3' }),
      new MockProvider({ id: 'perplexity', responses: () => 'a4' }),
    ]
    const verifier = makeVerifier({
      claude: { correct: true },
      gpt: { correct: false },
      gemini: { correct: null },
      perplexity: { correct: true },
    })
    const result = await runAccuracy({
      generator: GEN, verifier, probers, url: URL, scrape: longScrape,
    })
    expect(result.reason).toBe('ok')
    expect(result.valid).toBe(3) // one null dropped
    expect(result.correct).toBe(2)
    expect(result.score).toBe(67) // round(2/3*100)
  })

  it('re-throws generator errors (no fallback at the orchestrator)', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const gen = new MockProvider({ id: 'gpt', responses: {}, failWith: 'generator down' })
    await expect(runAccuracy({
      generator: gen,
      verifier: makeVerifier({}),
      probers: [new MockProvider({ id: 'claude', responses: () => 'a' })],
      url: URL,
      scrape: longScrape,
    })).rejects.toThrow('generator down')
  })

  it('records per-prober errors without aborting (other probers still verified)', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const claude = new MockProvider({ id: 'claude', responses: () => 'ok' })
    const gpt = new MockProvider({ id: 'gpt', responses: {}, failWith: 'rate' })
    const verifier = makeVerifier({ claude: { correct: true } })
    const result = await runAccuracy({
      generator: GEN, verifier, probers: [claude, gpt], url: URL, scrape: longScrape,
    })
    expect(result.probes).toHaveLength(2)
    expect(result.probes.find((p) => p.providerId === 'gpt')?.error).toBeTruthy()
    expect(result.verifications).toHaveLength(1) // only claude got verified
    expect(result.score).toBe(100)
    expect(result.reason).toBe('ok')
  })

  it('reason all_null when every verification returns correct:null', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const claude = new MockProvider({ id: 'claude', responses: () => 'vague' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'vague' })
    const verifier = makeVerifier({ claude: { correct: null }, gpt: { correct: null } })
    const result = await runAccuracy({
      generator: GEN, verifier, probers: [claude, gpt], url: URL, scrape: longScrape,
    })
    expect(result.reason).toBe('all_null')
    expect(result.score).toBeNull()
    expect(result.valid).toBe(0)
  })

  it('reason all_failed when every prober throws', async () => {
    const longScrape = { ...SCRAPE, text: SCRAPE.text.repeat(5) }
    const p1 = new MockProvider({ id: 'claude', responses: {}, failWith: 'down' })
    const p2 = new MockProvider({ id: 'gpt', responses: {}, failWith: 'down' })
    const result = await runAccuracy({
      generator: GEN, verifier: makeVerifier({}), probers: [p1, p2], url: URL, scrape: longScrape,
    })
    expect(result.reason).toBe('all_failed')
    expect(result.verifications).toEqual([])
    expect(result.probes.every((p) => p.error !== null)).toBe(true)
  })
})
