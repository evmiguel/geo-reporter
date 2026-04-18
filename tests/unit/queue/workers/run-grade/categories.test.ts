import { describe, expect, it } from 'vitest'
import { collapseToCategoryScore } from '../../../../../src/queue/workers/run-grade/categories.ts'

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
