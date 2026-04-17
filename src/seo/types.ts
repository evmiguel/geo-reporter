export const SIGNAL_WEIGHT = 10

export type SignalName =
  | 'title'
  | 'description'
  | 'canonical'
  | 'twitter-card'
  | 'open-graph'
  | 'jsonld'
  | 'robots'
  | 'sitemap'
  | 'llms-txt'
  | 'headings'

export interface SignalResult {
  name: SignalName
  pass: boolean
  weight: number
  detail: string
}

export interface SeoResult {
  score: number
  signals: SignalResult[]
}
