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

/**
 * Tailwind class string for the band color of a given score. Used by the live
 * letter hero and per-category tiles so an 'F' reads red and an 'A' reads green
 * instead of everything wearing the brand orange. Null/loading → dimmed neutral.
 */
export function scoreBandClass(score: number | null): string {
  if (score === null) return 'text-[var(--color-fg-dim)]'
  if (score >= 80) return 'text-[var(--color-good)]'
  if (score >= 70) return 'text-[var(--color-brand)]'
  if (score >= 60) return 'text-[var(--color-warn)]'
  return 'text-[var(--color-bad)]'
}

/**
 * Matching background-color class for progress bars.
 */
export function scoreBandBgClass(score: number | null): string {
  if (score === null) return 'bg-[var(--color-line)]'
  if (score >= 80) return 'bg-[var(--color-good)]'
  if (score >= 70) return 'bg-[var(--color-brand)]'
  if (score >= 60) return 'bg-[var(--color-warn)]'
  return 'bg-[var(--color-bad)]'
}

/**
 * One-word summary + range for a score band. Used under the hero letter so
 * users see meaning, not just a letter in isolation.
 */
export function letterDescriptor(score: number | null): { label: string; range: string } | null {
  if (score === null) return null
  if (score >= 90) return { label: 'Excellent', range: '90-100' }
  if (score >= 80) return { label: 'Good', range: '80-89' }
  if (score >= 70) return { label: 'Fair', range: '70-79' }
  if (score >= 60) return { label: 'Weak', range: '60-69' }
  return { label: 'Poor', range: '<60' }
}
