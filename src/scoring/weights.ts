export type CategoryId =
  | 'discoverability'
  | 'recognition'
  | 'accuracy'
  | 'coverage'
  | 'citation'
  | 'seo'

export const DEFAULT_WEIGHTS: Record<CategoryId, number> = {
  discoverability: 30,
  recognition: 20,
  accuracy: 20,
  coverage: 10,
  citation: 10,
  seo: 10,
}
