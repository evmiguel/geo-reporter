export function collapseToCategoryScore(scores: (number | null)[]): number | null {
  const numeric = scores.filter((s): s is number => s !== null)
  if (numeric.length === 0) return null
  return Math.round(numeric.reduce((a, b) => a + b, 0) / numeric.length)
}
