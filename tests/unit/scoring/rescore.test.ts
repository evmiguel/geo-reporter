import { describe, it, expect } from 'vitest'
import { rescoreFromProbes } from '../../../src/scoring/rescore.ts'
import type { Probe } from '../../../src/store/types.ts'

function probe(overrides: Partial<Probe>): Probe {
  return {
    id: crypto.randomUUID(), gradeId: 'g1',
    category: 'recognition', provider: 'claude',
    prompt: 'p', response: 'r', score: 75,
    metadata: {}, createdAt: new Date(),
    ...overrides,
  }
}

describe('rescoreFromProbes', () => {
  it('aggregates per-category scores across providers', () => {
    const probes: Probe[] = [
      probe({ category: 'recognition', provider: 'claude', score: 80 }),
      probe({ category: 'recognition', provider: 'gpt', score: 90 }),
      probe({ category: 'recognition', provider: 'gemini', score: 70 }),
      probe({ category: 'recognition', provider: 'perplexity', score: 60 }),
      probe({ category: 'seo', provider: null, score: 85, metadata: { label: 'title' } }),
    ]
    const result = rescoreFromProbes(probes)
    expect(result.scores.recognition).toBe(75)  // mean of 80,90,70,60
    expect(result.scores.seo).toBe(85)
    expect(result.overall).toBeGreaterThan(0)
    expect(result.letter).toMatch(/^[A-F][+-]?$/)
  })

  it('uses latest row per (category, provider, label) for dedup', () => {
    const older = probe({ category: 'recognition', provider: 'claude', score: 50, createdAt: new Date(1000) })
    const newer = probe({ category: 'recognition', provider: 'claude', score: 90, createdAt: new Date(2000) })
    const result = rescoreFromProbes([older, newer])
    expect(result.scores.recognition).toBe(90)
  })

  it('returns null for categories with no probes', () => {
    const result = rescoreFromProbes([probe({ category: 'recognition', score: 80 })])
    expect(result.scores.citation).toBeNull()
    expect(result.scores.accuracy).toBeNull()
  })

  it('null-drop in overall: categories with null score are dropped', () => {
    const result = rescoreFromProbes([
      probe({ category: 'recognition', score: 100 }),
      probe({ category: 'seo', provider: null, score: 100, metadata: { label: 't' } }),
    ])
    expect(result.overall).toBe(100)
  })
})
