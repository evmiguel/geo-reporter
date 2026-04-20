import { describe, expect, it } from 'vitest'
import { scoreToLetter, toLetterGrade } from '../../../src/scoring/letter.ts'

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

describe('scoreToLetter', () => {
  it('maps 90+ to A', () => {
    expect(scoreToLetter(100)).toBe('A')
    expect(scoreToLetter(95)).toBe('A')
    expect(scoreToLetter(90)).toBe('A')
  })
  it('maps 80-89 to B', () => {
    expect(scoreToLetter(89)).toBe('B')
    expect(scoreToLetter(80)).toBe('B')
  })
  it('maps 70-79 to C', () => {
    expect(scoreToLetter(79)).toBe('C')
    expect(scoreToLetter(70)).toBe('C')
  })
  it('maps 60-69 to D', () => {
    expect(scoreToLetter(69)).toBe('D')
    expect(scoreToLetter(60)).toBe('D')
  })
  it('maps < 60 to F', () => {
    expect(scoreToLetter(59)).toBe('F')
    expect(scoreToLetter(0)).toBe('F')
    expect(scoreToLetter(-5)).toBe('F')
  })
  it('returns null for null score', () => {
    expect(scoreToLetter(null)).toBeNull()
  })
})
