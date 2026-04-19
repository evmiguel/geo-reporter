import type { NewRecommendation } from '../../../src/store/types.ts'

export interface FakeRecommenderInput {
  url: string
  scrapeText: string
}

export interface RecommenderResult {
  recommendations: NewRecommendation[]
  attempts: number
  limited: boolean
}

function defaultRecs(gradeId: string): NewRecommendation[] {
  return [1, 2, 3, 4, 5].map((rank) => ({
    gradeId,
    rank,
    title: `Rec ${rank}`,
    category: 'recognition',
    impact: 4,
    effort: 2,
    rationale: 'because',
    how: 'do the thing',
  }))
}

export class FakeRecommender {
  readonly calls: FakeRecommenderInput[] = []

  constructor(
    private readonly result: (gradeId: string) => RecommenderResult = (gradeId) => ({
      recommendations: defaultRecs(gradeId),
      attempts: 1,
      limited: false,
    }),
  ) {}

  async generate(input: FakeRecommenderInput & { gradeId: string }): Promise<RecommenderResult> {
    this.calls.push({ url: input.url, scrapeText: input.scrapeText })
    return this.result(input.gradeId)
  }
}
