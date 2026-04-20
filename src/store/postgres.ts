import { eq, desc, and, isNull, sql } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db/client.ts'
import * as schema from '../db/schema.ts'
import type {
  GradeStore,
  Grade,
  GradeUpdate,
  NewGrade,
  Probe,
  NewProbe,
  Scrape,
  NewScrape,
  User,
  Cookie,
  Recommendation,
  NewRecommendation,
  Report,
  NewReport,
  ReportRecord,
  ReportPdfStatus,
  StripePayment,
} from './types.ts'

export class PostgresStore implements GradeStore {
  constructor(private readonly db: Db) {}

  async createGrade(input: NewGrade): Promise<Grade> {
    const [row] = await this.db.insert(schema.grades).values(input).returning()
    if (!row) throw new Error('createGrade returned no row')
    return row
  }

  async getGrade(id: string): Promise<Grade | null> {
    const [row] = await this.db.select().from(schema.grades).where(eq(schema.grades.id, id)).limit(1)
    return row ?? null
  }

  async updateGrade(id: string, patch: GradeUpdate): Promise<void> {
    await this.db.update(schema.grades).set({ ...patch, updatedAt: new Date() }).where(eq(schema.grades.id, id))
  }

  async createProbe(input: NewProbe): Promise<Probe> {
    const [row] = await this.db.insert(schema.probes).values(input).returning()
    if (!row) throw new Error('createProbe returned no row')
    return row
  }

  async listProbes(gradeId: string): Promise<Probe[]> {
    return this.db.select().from(schema.probes).where(eq(schema.probes.gradeId, gradeId)).orderBy(desc(schema.probes.createdAt))
  }

  async hasTerminalProviderFailures(gradeId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      SELECT 1 FROM probes
      WHERE grade_id = ${gradeId}
        AND provider IN ('claude', 'gpt')
        AND score IS NULL
        AND metadata->>'error' IS NOT NULL
      LIMIT 1
    `)
    return rows.length > 0
  }

  async createScrape(input: NewScrape): Promise<Scrape> {
    const [row] = await this.db.insert(schema.scrapes).values(input).returning()
    if (!row) throw new Error('createScrape returned no row')
    return row
  }

  async getScrape(gradeId: string): Promise<Scrape | null> {
    const [row] = await this.db.select().from(schema.scrapes).where(eq(schema.scrapes.gradeId, gradeId)).limit(1)
    return row ?? null
  }

  async clearGradeArtifacts(gradeId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.probes).where(eq(schema.probes.gradeId, gradeId))
      await tx.delete(schema.scrapes).where(eq(schema.scrapes.gradeId, gradeId))
    })
  }

  async upsertUser(email: string): Promise<User> {
    const [row] = await this.db
      .insert(schema.users)
      .values({ email })
      .onConflictDoUpdate({ target: schema.users.email, set: { email } })
      .returning()
    if (!row) throw new Error('upsertUser returned no row')
    return row
  }

  async upsertCookie(cookie: string, userId?: string): Promise<Cookie> {
    if (userId === undefined) {
      // Anonymous touch: create if missing, never overwrite an existing userId.
      const [inserted] = await this.db
        .insert(schema.cookies)
        .values({ cookie })
        .onConflictDoNothing({ target: schema.cookies.cookie })
        .returning()
      if (inserted) return inserted
      const [existing] = await this.db
        .select()
        .from(schema.cookies)
        .where(eq(schema.cookies.cookie, cookie))
        .limit(1)
      if (!existing) throw new Error('upsertCookie: conflict row disappeared')
      return existing
    }
    // Explicit promotion path.
    const [row] = await this.db
      .insert(schema.cookies)
      .values({ cookie, userId })
      .onConflictDoUpdate({ target: schema.cookies.cookie, set: { userId } })
      .returning()
    if (!row) throw new Error('upsertCookie returned no row')
    return row
  }

  async getCookie(cookie: string): Promise<Cookie | null> {
    const [row] = await this.db.select().from(schema.cookies).where(eq(schema.cookies.cookie, cookie)).limit(1)
    return row ?? null
  }

  async deleteUser(userId: string, expectedEmail: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
      if (!user || user.email.toLowerCase() !== expectedEmail.toLowerCase()) {
        throw new Error('deleteUser: user not found or email mismatch')
      }

      // Anonymize stripe_payments BEFORE deleting grades — stripe_payments.grade_id has ON DELETE CASCADE,
      // so we must detach the FK first to retain rows for tax retention.
      await tx.update(schema.stripePayments)
        .set({ userId: null, gradeId: null })
        .where(eq(schema.stripePayments.userId, userId))

      // Grades cascade to scrapes, probes, recommendations, reports, report_pdfs via FK ON DELETE CASCADE.
      await tx.delete(schema.grades).where(eq(schema.grades.userId, userId))

      // Unbind every cookie tied to this user (cookies row preserved — other devices may still use it as anonymous).
      await tx.update(schema.cookies).set({ userId: null }).where(eq(schema.cookies.userId, userId))

      // Purge pending magic-link tokens for this email.
      await tx.delete(schema.magicTokens).where(eq(schema.magicTokens.email, user.email))

      // Finally the user row.
      await tx.delete(schema.users).where(eq(schema.users.id, userId))
    })
  }

  async issueMagicToken(email: string, issuingCookie: string): Promise<{ rawToken: string; expiresAt: Date }> {
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000)
    await this.db.transaction(async (tx) => {
      await tx.update(schema.magicTokens)
        .set({ consumedAt: new Date() })
        .where(and(eq(schema.magicTokens.email, email), isNull(schema.magicTokens.consumedAt)))
      await tx.insert(schema.magicTokens).values({
        email,
        tokenHash,
        expiresAt,
        cookie: issuingCookie,
      })
    })
    return { rawToken, expiresAt }
  }

  async consumeMagicToken(
    tokenHash: string,
    clickingCookie: string,
  ): Promise<{ ok: true; email: string; userId: string } | { ok: false }> {
    return this.db.transaction(async (tx) => {
      const [tokenRow] = await tx.select().from(schema.magicTokens)
        .where(eq(schema.magicTokens.tokenHash, tokenHash))
        .limit(1)
      if (!tokenRow) return { ok: false as const }
      if (tokenRow.consumedAt !== null) return { ok: false as const }
      if (tokenRow.expiresAt.getTime() < Date.now()) return { ok: false as const }

      const [user] = await tx.insert(schema.users)
        .values({ email: tokenRow.email })
        .onConflictDoUpdate({ target: schema.users.email, set: { email: tokenRow.email } })
        .returning()
      if (!user) throw new Error('consumeMagicToken: user upsert returned no row')

      await tx.update(schema.cookies)
        .set({ userId: user.id })
        .where(eq(schema.cookies.cookie, clickingCookie))

      await tx.update(schema.magicTokens)
        .set({ consumedAt: new Date() })
        .where(eq(schema.magicTokens.id, tokenRow.id))

      return { ok: true as const, email: user.email, userId: user.id }
    })
  }

  async unbindCookie(cookie: string): Promise<void> {
    await this.db.update(schema.cookies).set({ userId: null }).where(eq(schema.cookies.cookie, cookie))
  }

  async getCookieWithUser(cookie: string): Promise<{ cookie: string; userId: string | null; email: string | null }> {
    const [row] = await this.db
      .select({
        cookie: schema.cookies.cookie,
        userId: schema.cookies.userId,
        email: schema.users.email,
      })
      .from(schema.cookies)
      .leftJoin(schema.users, eq(schema.users.id, schema.cookies.userId))
      .where(eq(schema.cookies.cookie, cookie))
      .limit(1)
    if (!row) return { cookie, userId: null, email: null }
    return { cookie: row.cookie, userId: row.userId, email: row.email }
  }

  async createRecommendations(rows: NewRecommendation[]): Promise<void> {
    if (rows.length === 0) return
    await this.db.insert(schema.recommendations).values(rows)
  }

  async listRecommendations(gradeId: string): Promise<Recommendation[]> {
    return this.db
      .select()
      .from(schema.recommendations)
      .where(eq(schema.recommendations.gradeId, gradeId))
      .orderBy(schema.recommendations.rank)
  }

  async createReport(input: NewReport): Promise<Report> {
    const [row] = await this.db.insert(schema.reports).values(input).returning()
    if (!row) throw new Error('createReport returned no row')
    return row
  }

  async getReport(gradeId: string): Promise<Report | null> {
    const [row] = await this.db.select().from(schema.reports).where(eq(schema.reports.gradeId, gradeId)).limit(1)
    return row ?? null
  }

  async getReportById(id: string): Promise<ReportRecord | null> {
    const [report] = await this.db.select().from(schema.reports).where(eq(schema.reports.id, id)).limit(1)
    if (!report) return null
    const [grade] = await this.db.select().from(schema.grades).where(eq(schema.grades.id, report.gradeId)).limit(1)
    if (!grade) return null
    if (grade.tier !== 'paid' || grade.status !== 'done') return null
    const [scrape] = await this.db.select().from(schema.scrapes).where(eq(schema.scrapes.gradeId, grade.id)).limit(1)
    const probes = await this.db.select().from(schema.probes)
      .where(eq(schema.probes.gradeId, grade.id))
      .orderBy(schema.probes.createdAt)
    const recommendations = await this.db.select().from(schema.recommendations)
      .where(eq(schema.recommendations.gradeId, grade.id))
      .orderBy(schema.recommendations.rank)
    return { report, grade, scrape: scrape ?? null, probes, recommendations }
  }

  async initReportPdfRow(reportId: string): Promise<void> {
    await this.db.insert(schema.reportPdfs)
      .values({ reportId, status: 'pending' })
      .onConflictDoNothing({ target: schema.reportPdfs.reportId })
  }

  async getReportPdf(reportId: string): Promise<{ status: ReportPdfStatus; bytes: Buffer | null } | null> {
    const [row] = await this.db.select().from(schema.reportPdfs)
      .where(eq(schema.reportPdfs.reportId, reportId)).limit(1)
    if (!row) return null
    return { status: row.status as ReportPdfStatus, bytes: row.bytes ?? null }
  }

  async writeReportPdf(reportId: string, bytes: Buffer): Promise<void> {
    await this.db.update(schema.reportPdfs)
      .set({ status: 'ready', bytes, errorMessage: null, updatedAt: new Date() })
      .where(eq(schema.reportPdfs.reportId, reportId))
  }

  async setReportPdfStatus(reportId: string, status: Exclude<ReportPdfStatus, 'ready'>, errorMessage?: string): Promise<void> {
    await this.db.update(schema.reportPdfs)
      .set({ status, errorMessage: errorMessage ?? null, updatedAt: new Date() })
      .where(eq(schema.reportPdfs.reportId, reportId))
  }

  async createStripePayment(input: {
    gradeId: string | null
    sessionId: string
    amountCents: number
    currency: string
    kind?: 'report' | 'credits'
    userId?: string | null
  }): Promise<StripePayment> {
    const [row] = await this.db.insert(schema.stripePayments).values({
      gradeId: input.gradeId,
      sessionId: input.sessionId,
      amountCents: input.amountCents,
      currency: input.currency,
      kind: input.kind ?? 'report',
      status: 'pending',
      userId: input.userId ?? null,
    }).returning()
    if (!row) throw new Error('createStripePayment returned no row')
    return row
  }

  async getStripePaymentBySessionId(sessionId: string): Promise<StripePayment | null> {
    const [row] = await this.db
      .select()
      .from(schema.stripePayments)
      .where(eq(schema.stripePayments.sessionId, sessionId))
      .limit(1)
    return row ?? null
  }

  async updateStripePaymentStatus(
    sessionId: string,
    patch: { status: 'paid' | 'refunded' | 'failed'; amountCents?: number; currency?: string },
  ): Promise<void> {
    await this.db.update(schema.stripePayments)
      .set({
        status: patch.status,
        updatedAt: new Date(),
        ...(patch.amountCents !== undefined ? { amountCents: patch.amountCents } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      })
      .where(eq(schema.stripePayments.sessionId, sessionId))
  }

  async listStripePaymentsByGrade(gradeId: string): Promise<StripePayment[]> {
    return this.db.select().from(schema.stripePayments).where(eq(schema.stripePayments.gradeId, gradeId))
  }

  async getCredits(userId: string): Promise<number> {
    const [row] = await this.db.select({ credits: schema.users.credits })
      .from(schema.users).where(eq(schema.users.id, userId)).limit(1)
    return row?.credits ?? 0
  }

  async grantCreditsAndMarkPaid(
    sessionId: string,
    userId: string,
    creditCount: number,
    amountCents: number,
    currency: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(schema.users)
        .set({ credits: sql`${schema.users.credits} + ${creditCount}` })
        .where(eq(schema.users.id, userId))
      await tx.update(schema.stripePayments)
        .set({ status: 'paid', amountCents, currency, updatedAt: new Date() })
        .where(eq(schema.stripePayments.sessionId, sessionId))
    })
  }

  async redeemCredit(userId: string): Promise<{ ok: true; remaining: number } | { ok: false }> {
    const [row] = await this.db.update(schema.users)
      .set({ credits: sql`${schema.users.credits} - 1` })
      .where(and(eq(schema.users.id, userId), sql`${schema.users.credits} > 0`))
      .returning({ credits: schema.users.credits })
    if (!row) return { ok: false }
    return { ok: true, remaining: row.credits }
  }

  async getCookieWithUserAndCredits(cookie: string): Promise<{
    cookie: string; userId: string | null; email: string | null; credits: number
  }> {
    const [row] = await this.db
      .select({
        cookie: schema.cookies.cookie,
        userId: schema.cookies.userId,
        email: schema.users.email,
        credits: schema.users.credits,
      })
      .from(schema.cookies)
      .leftJoin(schema.users, eq(schema.users.id, schema.cookies.userId))
      .where(eq(schema.cookies.cookie, cookie))
      .limit(1)
    if (!row) return { cookie, userId: null, email: null, credits: 0 }
    return {
      cookie: row.cookie,
      userId: row.userId,
      email: row.email,
      credits: row.credits ?? 0,
    }
  }
}
