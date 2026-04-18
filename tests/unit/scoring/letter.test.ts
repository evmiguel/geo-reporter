import { describe, expect, it } from 'vitest'
import { toLetterGrade } from '../../../src/scoring/letter.ts'

describe('toLetterGrade', () => {
  it('maps 100 → A+', () => expect(toLetterGrade(100)).toBe('A+'))
  it('maps 97 → A+', () => expect(toLetterGrade(97)).toBe('A+'))
  it('maps 96 → A', () => expect(toLetterGrade(96)).toBe('A'))
  it('maps 93 → A', () => expect(toLetterGrade(93)).toBe('A'))
  it('maps 90 → A−', () => expect(toLetterGrade(90)).toBe('A−'))
  it('maps 87 → B+', () => expect(toLetterGrade(87)).toBe('B+'))
  it('maps 83 → B', () => expect(toLetterGrade(83)).toBe('B'))
  it('maps 80 → B−', () => expect(toLetterGrade(80)).toBe('B−'))
  it('maps 77 → C+', () => expect(toLetterGrade(77)).toBe('C+'))
  it('maps 70 → C−', () => expect(toLetterGrade(70)).toBe('C−'))
  it('maps 60 → D', () => expect(toLetterGrade(60)).toBe('D'))
  it('maps 0 → F', () => expect(toLetterGrade(0)).toBe('F'))
  it('maps 50 → F', () => expect(toLetterGrade(50)).toBe('F'))
})
