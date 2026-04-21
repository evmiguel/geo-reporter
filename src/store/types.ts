import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type * as schema from '../db/schema.ts'

export type Grade = InferSelectModel<typeof schema.grades>
export type NewGrade = InferInsertModel<typeof schema.grades>
export type GradeUpdate = Partial<Pick<Grade, 'status' | 'overall' | 'letter' | 'scores' | 'cookie' | 'userId' | 'tier'>>
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

export type ReportPdfStatus = 'pending' | 'ready' | 'failed'

export interface ReportRecord {
  report: Report
  grade: Grade
  scrape: Scrape | null
  probes: Probe[]
  recommendations: Recommendation[]
}

export interface GradeStore {
  // Grades
  createGrade(input: NewGrade): Promise<Grade>
  getGrade(id: string): Promise<Grade | null>
  listGradesByUser(userId: string, limit: number): Promise<Grade[]>
  updateGrade(id: string, patch: GradeUpdate): Promise<void>

  // Probes
  createProbe(input: NewProbe): Promise<Probe>
  listProbes(gradeId: string): Promise<Probe[]>
  hasTerminalProviderFailures(gradeId: string): Promise<boolean>

  // Scrapes
  createScrape(input: NewScrape): Promise<Scrape>
  getScrape(gradeId: string): Promise<Scrape | null>
  // Worker retry helper: atomically deletes scrape + probe rows for one grade.
  clearGradeArtifacts(gradeId: string): Promise<void>

  // Users / cookies (placeholder; expanded in auth plan)
  upsertUser(email: string): Promise<User>
  upsertCookie(cookie: string, userId?: string): Promise<Cookie>
  getCookie(cookie: string): Promise<Cookie | null>
  deleteUser(userId: string, expectedEmail: string): Promise<void>

  // Recommendations (expanded in report plan)
  createRecommendations(rows: NewRecommendation[]): Promise<void>
  listRecommendations(gradeId: string): Promise<Recommendation[]>

  // Reports (expanded in report plan)
  createReport(input: NewReport): Promise<Report>
  getReport(gradeId: string): Promise<Report | null>
  getReportById(id: string): Promise<ReportRecord | null>
  initReportPdfRow(reportId: string): Promise<void>
  getReportPdf(reportId: string): Promise<{ status: ReportPdfStatus; bytes: Buffer | null } | null>
  writeReportPdf(reportId: string, bytes: Buffer): Promise<void>
  setReportPdfStatus(reportId: string, status: Exclude<ReportPdfStatus, 'ready'>, errorMessage?: string): Promise<void>

  // Auth — magic-link flow (Plan 7)
  issueMagicToken(email: string, issuingCookie: string): Promise<{ rawToken: string; expiresAt: Date }>
  consumeMagicToken(tokenHash: string, clickingCookie: string): Promise<
    | { ok: true; email: string; userId: string }
    | { ok: false }
  >
  unbindCookie(cookie: string): Promise<void>
  getCookieWithUser(cookie: string): Promise<{ cookie: string; userId: string | null; email: string | null }>

  // Billing — stripe_payments (Plan 8)
  createStripePayment(input: {
    gradeId: string | null
    sessionId: string
    amountCents: number
    currency: string
    kind?: 'report' | 'credits'
    userId?: string | null
  }): Promise<StripePayment>
  getStripePaymentBySessionId(sessionId: string): Promise<StripePayment | null>
  updateStripePaymentStatus(
    sessionId: string,
    patch: { status: 'paid' | 'refunded' | 'failed'; amountCents?: number; currency?: string },
  ): Promise<void>
  listStripePaymentsByGrade(gradeId: string): Promise<StripePayment[]>

  // Credits (credits pack)
  getCredits(userId: string): Promise<number>
  grantCreditsAndMarkPaid(
    sessionId: string,
    userId: string,
    creditCount: number,
    amountCents: number,
    currency: string,
  ): Promise<void>
  redeemCredit(userId: string): Promise<{ ok: true; remaining: number } | { ok: false }>
  incrementCredits(userId: string, delta: number): Promise<number>
  getCookieWithUserAndCredits(cookie: string): Promise<{
    cookie: string
    userId: string | null
    email: string | null
    credits: number
  }>
}
