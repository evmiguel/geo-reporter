import { createHash, randomBytes } from 'node:crypto'
import type {
  GradeStore, Grade, Probe, Scrape, NewGrade, NewProbe, NewScrape, GradeUpdate,
  User, Cookie, Recommendation, NewRecommendation, Report, NewReport, MagicToken,
  ReportRecord, ReportPdfStatus, StripePayment,
} from '../../../src/store/types.ts'

export interface FakeGradeStore extends GradeStore {
  gradesMap: Map<string, Grade>
  scrapesMap: Map<string, Scrape>
  probes: Probe[]
  cookiesMap: Map<string, Cookie>
  usersMap: Map<string, User>
  clearedFor: string[]
  magicTokensMap: Map<string, MagicToken>
  stripePaymentsMap: Map<string, StripePayment>
  recommendations: Recommendation[]
  reportsMap: Map<string, Report>
  _hashForTest(raw: string): string
}

export function makeFakeStore(): FakeGradeStore {
  const gradesMap = new Map<string, Grade>()
  const scrapesMap = new Map<string, Scrape>()
  const probes: Probe[] = []
  const cookiesMap = new Map<string, Cookie>()
  const usersMap = new Map<string, User>()
  const clearedFor: string[] = []
  const magicTokensMap = new Map<string, MagicToken>()
  const stripePaymentsMap = new Map<string, StripePayment>()
  const recommendations: Recommendation[] = []
  const reportsMap = new Map<string, Report>()
  const reportPdfsMap = new Map<string, { status: ReportPdfStatus; bytes: Buffer | null; errorMessage: string | null }>()
  function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex')
  }

  return {
    gradesMap, scrapesMap, probes, cookiesMap, usersMap, clearedFor,
    magicTokensMap,
    stripePaymentsMap,
    recommendations,
    reportsMap,
    _hashForTest(raw: string): string { return hashToken(raw) },

    async createGrade(input: NewGrade): Promise<Grade> {
      const id = input.id ?? crypto.randomUUID()
      const now = new Date()
      const g: Grade = {
        id, url: input.url, domain: input.domain, tier: input.tier,
        cookie: input.cookie ?? null, userId: input.userId ?? null,
        status: input.status ?? 'queued',
        overall: input.overall ?? null, letter: input.letter ?? null, scores: input.scores ?? null,
        createdAt: now, updatedAt: now,
      }
      gradesMap.set(id, g)
      return g
    },
    async getGrade(id: string): Promise<Grade | null> { return gradesMap.get(id) ?? null },
    async updateGrade(id: string, patch: GradeUpdate): Promise<void> {
      const g = gradesMap.get(id)
      if (!g) return
      gradesMap.set(id, { ...g, ...patch, updatedAt: new Date() })
    },
    async createProbe(input: NewProbe): Promise<Probe> {
      const p: Probe = {
        id: crypto.randomUUID(), gradeId: input.gradeId, category: input.category,
        provider: input.provider ?? null, prompt: input.prompt, response: input.response,
        score: input.score ?? null, metadata: input.metadata ?? {}, createdAt: new Date(),
      }
      probes.push(p)
      return p
    },
    async listProbes(gradeId: string): Promise<Probe[]> {
      return probes.filter((p) => p.gradeId === gradeId)
    },
    async hasTerminalProviderFailures(gradeId: string): Promise<boolean> {
      for (const p of probes) {
        if (p.gradeId !== gradeId) continue
        if (p.provider !== 'claude' && p.provider !== 'openai') continue
        if (p.score !== null) continue
        const meta = (p.metadata ?? {}) as Record<string, unknown>
        if (typeof meta.error === 'string') return true
      }
      return false
    },
    async createScrape(input: NewScrape): Promise<Scrape> {
      const s: Scrape = {
        id: crypto.randomUUID(), gradeId: input.gradeId, rendered: input.rendered ?? false,
        html: input.html, text: input.text, structured: input.structured,
        fetchedAt: input.fetchedAt ?? new Date(),
      }
      scrapesMap.set(input.gradeId, s)
      return s
    },
    async getScrape(gradeId: string): Promise<Scrape | null> { return scrapesMap.get(gradeId) ?? null },
    async clearGradeArtifacts(gradeId: string): Promise<void> {
      clearedFor.push(gradeId)
      scrapesMap.delete(gradeId)
      for (let i = probes.length - 1; i >= 0; i--) if (probes[i]?.gradeId === gradeId) probes.splice(i, 1)
    },
    async upsertUser(email: string): Promise<User> {
      const existing = [...usersMap.values()].find((u) => u.email === email)
      if (existing) return existing
      const u: User = { id: crypto.randomUUID(), email, credits: 0, createdAt: new Date() }
      usersMap.set(u.id, u)
      return u
    },
    async upsertCookie(cookie: string, userId?: string): Promise<Cookie> {
      const existing = cookiesMap.get(cookie)
      if (existing) {
        if (userId !== undefined) {
          const updated: Cookie = { ...existing, userId }
          cookiesMap.set(cookie, updated)
          return updated
        }
        return existing
      }
      const c: Cookie = { cookie, userId: userId ?? null, createdAt: new Date() }
      cookiesMap.set(cookie, c)
      return c
    },
    async getCookie(cookie: string): Promise<Cookie | null> {
      return cookiesMap.get(cookie) ?? null
    },
    async deleteUser(userId: string, expectedEmail: string): Promise<void> {
      const user = usersMap.get(userId)
      if (!user || user.email.toLowerCase() !== expectedEmail.toLowerCase()) {
        throw new Error('deleteUser: user not found or email mismatch')
      }
      // Collect this user's grade ids
      const userGradeIds = new Set<string>()
      for (const g of gradesMap.values()) {
        if (g.userId === userId) userGradeIds.add(g.id)
      }
      for (const gid of userGradeIds) {
        gradesMap.delete(gid)
        scrapesMap.delete(gid)
        reportsMap.delete(gid)
      }
      // probes / recommendations are arrays keyed by gradeId
      for (let i = probes.length - 1; i >= 0; i--) {
        if (userGradeIds.has(probes[i]!.gradeId)) probes.splice(i, 1)
      }
      for (let i = recommendations.length - 1; i >= 0; i--) {
        if (userGradeIds.has(recommendations[i]!.gradeId)) recommendations.splice(i, 1)
      }
      // Unbind cookies
      for (const [k, c] of cookiesMap) {
        if (c.userId === userId) cookiesMap.set(k, { ...c, userId: null })
      }
      // Purge magic tokens for this email
      for (const [id, t] of magicTokensMap) {
        if (t.email === user.email) magicTokensMap.delete(id)
      }
      // Anonymize stripe_payments
      for (const [k, p] of stripePaymentsMap) {
        if (p.userId === userId) stripePaymentsMap.set(k, { ...p, userId: null, gradeId: null })
      }
      // Delete user
      usersMap.delete(userId)
    },
    async issueMagicToken(email: string, issuingCookie: string): Promise<{ rawToken: string; expiresAt: Date }> {
      // Invalidate priors for this email.
      for (const [id, row] of magicTokensMap.entries()) {
        if (row.email === email && row.consumedAt === null) {
          magicTokensMap.set(id, { ...row, consumedAt: new Date() })
        }
      }
      const rawToken = randomBytes(32).toString('base64url')
      const tokenHash = hashToken(rawToken)
      const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000)
      const id = crypto.randomUUID()
      magicTokensMap.set(id, {
        id,
        email,
        tokenHash,
        expiresAt,
        consumedAt: null,
        cookie: issuingCookie,
        createdAt: new Date(),
      })
      return { rawToken, expiresAt }
    },
    async consumeMagicToken(
      tokenHash: string,
      clickingCookie: string,
    ): Promise<{ ok: true; email: string; userId: string } | { ok: false }> {
      let found: MagicToken | undefined
      let foundId: string | undefined
      for (const [id, row] of magicTokensMap.entries()) {
        if (row.tokenHash === tokenHash) { found = row; foundId = id; break }
      }
      if (!found || !foundId) return { ok: false }
      if (found.consumedAt !== null) return { ok: false }
      if (found.expiresAt.getTime() < Date.now()) return { ok: false }

      let user = [...usersMap.values()].find((u) => u.email === found!.email)
      if (!user) {
        user = { id: crypto.randomUUID(), email: found.email, credits: 0, createdAt: new Date() }
        usersMap.set(user.id, user)
      }
      const resolvedUser = user

      const clicker = cookiesMap.get(clickingCookie)
      if (clicker) {
        cookiesMap.set(clickingCookie, { ...clicker, userId: resolvedUser.id })
      } else {
        cookiesMap.set(clickingCookie, { cookie: clickingCookie, userId: resolvedUser.id, createdAt: new Date() })
      }

      magicTokensMap.set(foundId, { ...found, consumedAt: new Date() })

      return { ok: true, email: resolvedUser.email, userId: resolvedUser.id }
    },
    async unbindCookie(cookie: string): Promise<void> {
      const row = cookiesMap.get(cookie)
      if (!row) return
      cookiesMap.set(cookie, { ...row, userId: null })
    },
    async getCookieWithUser(cookie: string): Promise<{ cookie: string; userId: string | null; email: string | null }> {
      const row = cookiesMap.get(cookie)
      if (!row) return { cookie, userId: null, email: null }
      if (!row.userId) return { cookie, userId: null, email: null }
      const user = usersMap.get(row.userId)
      return { cookie, userId: row.userId, email: user?.email ?? null }
    },
    async createStripePayment(input: {
      gradeId: string | null
      sessionId: string
      amountCents: number
      currency: string
      kind?: 'report' | 'credits'
      userId?: string | null
    }): Promise<StripePayment> {
      const row: StripePayment = {
        id: crypto.randomUUID(),
        gradeId: input.gradeId,
        userId: input.userId ?? null,
        sessionId: input.sessionId,
        kind: input.kind ?? 'report',
        status: 'pending',
        amountCents: input.amountCents,
        currency: input.currency,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      stripePaymentsMap.set(input.sessionId, row)
      return row
    },
    async getCredits(userId: string): Promise<number> {
      const user = usersMap.get(userId)
      return user?.credits ?? 0
    },
    async grantCreditsAndMarkPaid(
      sessionId: string,
      userId: string,
      creditCount: number,
      amountCents: number,
      currency: string,
    ): Promise<void> {
      const user = usersMap.get(userId)
      if (!user) throw new Error(`FakeStore.grantCreditsAndMarkPaid: unknown user ${userId}`)
      usersMap.set(userId, { ...user, credits: user.credits + creditCount })
      const row = stripePaymentsMap.get(sessionId)
      if (!row) throw new Error(`FakeStore.grantCreditsAndMarkPaid: unknown session ${sessionId}`)
      stripePaymentsMap.set(sessionId, {
        ...row,
        status: 'paid',
        amountCents,
        currency,
        updatedAt: new Date(),
      })
    },
    async redeemCredit(userId: string): Promise<{ ok: true; remaining: number } | { ok: false }> {
      const user = usersMap.get(userId)
      if (!user || user.credits <= 0) return { ok: false }
      const remaining = user.credits - 1
      usersMap.set(userId, { ...user, credits: remaining })
      return { ok: true, remaining }
    },
    async getCookieWithUserAndCredits(cookie: string): Promise<{
      cookie: string; userId: string | null; email: string | null; credits: number
    }> {
      const row = cookiesMap.get(cookie)
      if (!row) return { cookie, userId: null, email: null, credits: 0 }
      if (!row.userId) return { cookie, userId: null, email: null, credits: 0 }
      const user = usersMap.get(row.userId)
      return {
        cookie,
        userId: row.userId,
        email: user?.email ?? null,
        credits: user?.credits ?? 0,
      }
    },
    async getStripePaymentBySessionId(sessionId: string): Promise<StripePayment | null> {
      return stripePaymentsMap.get(sessionId) ?? null
    },
    async updateStripePaymentStatus(
      sessionId: string,
      patch: { status: 'paid' | 'refunded' | 'failed'; amountCents?: number; currency?: string },
    ): Promise<void> {
      const existing = stripePaymentsMap.get(sessionId)
      if (!existing) return
      stripePaymentsMap.set(sessionId, {
        ...existing,
        status: patch.status,
        amountCents: patch.amountCents ?? existing.amountCents,
        currency: patch.currency ?? existing.currency,
        updatedAt: new Date(),
      })
    },
    async listStripePaymentsByGrade(gradeId: string): Promise<StripePayment[]> {
      return [...stripePaymentsMap.values()].filter((r) => r.gradeId === gradeId)
    },
    async createRecommendations(rows: NewRecommendation[]): Promise<void> {
      for (const row of rows) {
        recommendations.push({
          id: crypto.randomUUID(),
          gradeId: row.gradeId,
          rank: row.rank,
          title: row.title,
          category: row.category,
          impact: row.impact,
          effort: row.effort,
          rationale: row.rationale,
          how: row.how,
          createdAt: new Date(),
        })
      }
    },
    async listRecommendations(gradeId: string): Promise<Recommendation[]> {
      return recommendations
        .filter((r) => r.gradeId === gradeId)
        .sort((a, b) => a.rank - b.rank)
    },
    async createReport(input: NewReport): Promise<Report> {
      const row: Report = { id: crypto.randomUUID(), gradeId: input.gradeId, token: input.token, createdAt: new Date() }
      reportsMap.set(input.gradeId, row)
      return row
    },
    async getReport(gradeId: string): Promise<Report | null> {
      return reportsMap.get(gradeId) ?? null
    },
    async getReportById(id: string): Promise<ReportRecord | null> {
      const report = [...reportsMap.values()].find((r) => r.id === id)
      if (!report) return null
      const grade = gradesMap.get(report.gradeId)
      if (!grade) return null
      if (grade.tier !== 'paid' || grade.status !== 'done') return null
      const scrape = scrapesMap.get(grade.id) ?? null
      const probesForGrade = probes
        .filter((p) => p.gradeId === grade.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      const recsForGrade = recommendations
        .filter((r) => r.gradeId === grade.id)
        .sort((a, b) => a.rank - b.rank)
      return { report, grade, scrape, probes: probesForGrade, recommendations: recsForGrade }
    },
    async initReportPdfRow(reportId: string): Promise<void> {
      if (reportPdfsMap.has(reportId)) return
      reportPdfsMap.set(reportId, { status: 'pending', bytes: null, errorMessage: null })
    },
    async getReportPdf(reportId: string): Promise<{ status: ReportPdfStatus; bytes: Buffer | null } | null> {
      const row = reportPdfsMap.get(reportId)
      if (!row) return null
      return { status: row.status, bytes: row.bytes }
    },
    async writeReportPdf(reportId: string, bytes: Buffer): Promise<void> {
      const row = reportPdfsMap.get(reportId)
      if (!row) return
      reportPdfsMap.set(reportId, { status: 'ready', bytes, errorMessage: null })
    },
    async setReportPdfStatus(
      reportId: string,
      status: Exclude<ReportPdfStatus, 'ready'>,
      errorMessage?: string,
    ): Promise<void> {
      const row = reportPdfsMap.get(reportId)
      if (!row) return
      reportPdfsMap.set(reportId, { ...row, status, errorMessage: errorMessage ?? null })
    },
  }
}
