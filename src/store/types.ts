import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type * as schema from '../db/schema.ts'

export type Grade = InferSelectModel<typeof schema.grades>
export type NewGrade = InferInsertModel<typeof schema.grades>
export type GradeUpdate = Partial<Pick<Grade, 'status' | 'overall' | 'letter' | 'scores' | 'cookie' | 'userId'>>
export type Probe = InferSelectModel<typeof schema.probes>
export type NewProbe = InferInsertModel<typeof schema.probes>
export type Scrape = InferSelectModel<typeof schema.scrapes>
export type NewScrape = InferInsertModel<typeof schema.scrapes>
export type User = InferSelectModel<typeof schema.users>
export type Cookie = InferSelectModel<typeof schema.cookies>
export type Recommendation = InferSelectModel<typeof schema.recommendations>
export type NewRecommendation = InferInsertModel<typeof schema.recommendations>
export type Report = InferSelectModel<typeof schema.reports>
export type NewReport = InferInsertModel<typeof schema.reports>
export type StripePayment = InferSelectModel<typeof schema.stripePayments>
export type MagicToken = InferSelectModel<typeof schema.magicTokens>

export interface GradeStore {
  // Grades
  createGrade(input: NewGrade): Promise<Grade>
  getGrade(id: string): Promise<Grade | null>
  updateGrade(id: string, patch: GradeUpdate): Promise<void>

  // Probes
  createProbe(input: NewProbe): Promise<Probe>
  listProbes(gradeId: string): Promise<Probe[]>

  // Scrapes
  createScrape(input: NewScrape): Promise<Scrape>
  getScrape(gradeId: string): Promise<Scrape | null>
  // Worker retry helper: atomically deletes scrape + probe rows for one grade.
  clearGradeArtifacts(gradeId: string): Promise<void>

  // Users / cookies (placeholder; expanded in auth plan)
  upsertUser(email: string): Promise<User>
  upsertCookie(cookie: string, userId?: string): Promise<Cookie>

  // Recommendations (expanded in report plan)
  createRecommendations(rows: NewRecommendation[]): Promise<void>
  listRecommendations(gradeId: string): Promise<Recommendation[]>

  // Reports (expanded in report plan)
  createReport(input: NewReport): Promise<Report>
  getReport(gradeId: string): Promise<Report | null>
}
