import { describe, expect, it } from 'vitest'
import { weightedOverall } from '../../../src/scoring/composite.ts'
import { DEFAULT_WEIGHTS } from '../../../src/scoring/weights.ts'

describe('weightedOverall', () => {
  it('computes the weighted overall when all six categories are scored', () => {
    const r = weightedOverall({
      discoverability: 100, recognition: 80, accuracy: 60, coverage: 70, citation: 50, seo: 40,
    }, DEFAULT_WEIGHTS)
    expect(r.overall).toBe(74)
    expect(r.letter).toBe('C')
    expect(r.droppedCategories).toEqual([])
  })

  it('renormalizes when accuracy is null', () => {
    const r = weightedOverall({
      discoverability: 100, recognition: 80, accuracy: null, coverage: 70, citation: 50, seo: 40,
    }, DEFAULT_WEIGHTS)
    expect(r.overall).toBe(78)
    expect(r.droppedCategories).toEqual(['accuracy'])
  })

  it('drops multiple null categories and still computes a valid score', () => {
    const r = weightedOverall({
      discoverability: 100, recognition: 80, accuracy: null, coverage: null, citation: 50, seo: null,
    }, DEFAULT_WEIGHTS)
    expect(r.overall).toBe(85)
    expect(r.droppedCategories.sort()).toEqual(['accuracy', 'coverage', 'seo'].sort())
  })

  it('returns overall 0 / letter F when all categories are null', () => {
    const r = weightedOverall({
      discoverability: null, recognition: null, accuracy: null, coverage: null, citation: null, seo: null,
    }, DEFAULT_WEIGHTS)
    expect(r.overall).toBe(0)
    expect(r.letter).toBe('F')
    expect(r.droppedCategories.length).toBe(6)
  })

  it('treats missing keys as dropped categories', () => {
    const r = weightedOverall({
      discoverability: 100, recognition: 100,
    }, DEFAULT_WEIGHTS)
    expect(r.droppedCategories.sort()).toEqual(['accuracy', 'citation', 'coverage', 'seo'].sort())
    expect(r.overall).toBe(100)
  })

  it('usedWeights renormalizes to sum to 100', () => {
    const r = weightedOverall({
      discoverability: 50, recognition: 50, accuracy: null, coverage: null, citation: null, seo: null,
    }, DEFAULT_WEIGHTS)
    const sum = Object.values(r.usedWeights).reduce((s, n) => s + n, 0)
    expect(sum).toBe(100)
  })
})
