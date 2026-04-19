import { describe, it, expect, vi } from 'vitest'
import { runRecommender } from '../../../../src/queue/workers/generate-report/recommender.ts'

const baseInput = {
  gradeId: 'g1', url: 'https://x', scores: { recognition: 80 },
  failingSeoSignals: [], accuracyQuestion: null, accuracyAnswers: [],
  llmDescriptions: [], scrapeText: 'some text',
}

function makeQueryResult(text: string) {
  return { text, ms: 100, inputTokens: 100, outputTokens: 50 }
}

describe('runRecommender', () => {
  it('happy path: valid JSON with 5+ recs', async () => {
    const provider = {
      id: 'claude' as const,
      model: 'stub:claude',
      query: vi.fn().mockResolvedValue(makeQueryResult(JSON.stringify([
        { title: 'r1', category: 'recognition', impact: 5, effort: 2, rationale: 'r', how: 'h' },
        { title: 'r2', category: 'seo', impact: 4, effort: 2, rationale: 'r', how: 'h' },
        { title: 'r3', category: 'accuracy', impact: 3, effort: 3, rationale: 'r', how: 'h' },
        { title: 'r4', category: 'citation', impact: 2, effort: 1, rationale: 'r', how: 'h' },
        { title: 'r5', category: 'coverage', impact: 4, effort: 4, rationale: 'r', how: 'h' },
      ]))),
    }
    const result = await runRecommender({ provider }, baseInput)
    expect(result.limited).toBe(false)
    expect(result.recommendations).toHaveLength(5)
    expect(result.attempts).toBe(1)
  })

  it('retry on invalid JSON: second call succeeds', async () => {
    const provider = {
      id: 'claude' as const,
      model: 'stub:claude',
      query: vi.fn()
        .mockResolvedValueOnce(makeQueryResult('NOT JSON'))
        .mockResolvedValueOnce(makeQueryResult(JSON.stringify([
          { title: 'r1', category: 'recognition', impact: 5, effort: 2, rationale: 'r', how: 'h' },
          { title: 'r2', category: 'seo', impact: 4, effort: 2, rationale: 'r', how: 'h' },
          { title: 'r3', category: 'accuracy', impact: 3, effort: 3, rationale: 'r', how: 'h' },
          { title: 'r4', category: 'citation', impact: 2, effort: 1, rationale: 'r', how: 'h' },
          { title: 'r5', category: 'coverage', impact: 4, effort: 4, rationale: 'r', how: 'h' },
        ]))),
    }
    const result = await runRecommender({ provider }, baseInput)
    expect(result.attempts).toBe(2)
    expect(result.limited).toBe(false)
  })

  it('retry on <5 recs: second call returns 6', async () => {
    const short = JSON.stringify([
      { title: 't', category: 'recognition', impact: 1, effort: 1, rationale: 'r', how: 'h' },
    ])
    const fine = JSON.stringify([
      { title: 'r1', category: 'recognition', impact: 5, effort: 2, rationale: 'r', how: 'h' },
      { title: 'r2', category: 'seo', impact: 4, effort: 2, rationale: 'r', how: 'h' },
      { title: 'r3', category: 'accuracy', impact: 3, effort: 3, rationale: 'r', how: 'h' },
      { title: 'r4', category: 'citation', impact: 2, effort: 1, rationale: 'r', how: 'h' },
      { title: 'r5', category: 'coverage', impact: 4, effort: 4, rationale: 'r', how: 'h' },
      { title: 'r6', category: 'discoverability', impact: 5, effort: 3, rationale: 'r', how: 'h' },
    ])
    const provider = {
      id: 'claude' as const,
      model: 'stub:claude',
      query: vi.fn()
        .mockResolvedValueOnce(makeQueryResult(short))
        .mockResolvedValueOnce(makeQueryResult(fine)),
    }
    const result = await runRecommender({ provider }, baseInput)
    expect(result.recommendations).toHaveLength(6)
    expect(result.attempts).toBe(2)
  })

  it('both attempts fail: returns empty + limited=true', async () => {
    const provider = {
      id: 'claude' as const,
      model: 'stub:claude',
      query: vi.fn().mockResolvedValue(makeQueryResult('totally broken')),
    }
    const result = await runRecommender({ provider }, baseInput)
    expect(result.recommendations).toHaveLength(0)
    expect(result.limited).toBe(true)
    expect(result.attempts).toBe(2)
  })
})
