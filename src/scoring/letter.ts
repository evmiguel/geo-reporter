const LETTER_THRESHOLDS: [number, string][] = [
  [97, 'A+'], [93, 'A'], [90, 'A−'],
  [87, 'B+'], [83, 'B'], [80, 'B−'],
  [77, 'C+'], [73, 'C'], [70, 'C−'],
  [60, 'D'], [0, 'F'],
]

export function toLetterGrade(score: number): string {
  for (const [threshold, letter] of LETTER_THRESHOLDS) {
    if (score >= threshold) return letter
  }
  return 'F'
}

export type Letter = 'A' | 'B' | 'C' | 'D' | 'F'

export function scoreToLetter(score: number | null): Letter | null {
  if (score === null) return null
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}
