import { eq, desc, and, isNull } from 'drizzle-orm'
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
}
