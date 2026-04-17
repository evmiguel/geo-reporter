import { eq, desc } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import * as schema from '../db/schema.ts'
import type {
  GradeStore,
  Grade,
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

  async updateGrade(id: string, patch: Partial<Grade>): Promise<void> {
    const { id: _omit, ...rest } = patch
    await this.db.update(schema.grades).set({ ...rest, updatedAt: new Date() }).where(eq(schema.grades.id, id))
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
    const [row] = await this.db
      .insert(schema.cookies)
      .values({ cookie, userId: userId ?? null })
      .onConflictDoUpdate({ target: schema.cookies.cookie, set: { userId: userId ?? null } })
      .returning()
    if (!row) throw new Error('upsertCookie returned no row')
    return row
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
