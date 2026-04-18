import type {
  GradeStore, Grade, Probe, Scrape, NewGrade, NewProbe, NewScrape, GradeUpdate,
  User, Cookie, Recommendation, NewRecommendation, Report, NewReport,
} from '../../../src/store/types.ts'

export interface FakeGradeStore extends GradeStore {
  gradesMap: Map<string, Grade>
  scrapesMap: Map<string, Scrape>
  probes: Probe[]
  cookiesMap: Map<string, Cookie>
  usersMap: Map<string, User>
  clearedFor: string[]
}

export function makeFakeStore(): FakeGradeStore {
  const gradesMap = new Map<string, Grade>()
  const scrapesMap = new Map<string, Scrape>()
  const probes: Probe[] = []
  const cookiesMap = new Map<string, Cookie>()
  const usersMap = new Map<string, User>()
  const clearedFor: string[] = []

  return {
    gradesMap, scrapesMap, probes, cookiesMap, usersMap, clearedFor,

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
      const u: User = { id: crypto.randomUUID(), email, createdAt: new Date() }
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
    async createRecommendations(_rows: NewRecommendation[]): Promise<void> {},
    async listRecommendations(_gradeId: string): Promise<Recommendation[]> { return [] },
    async createReport(input: NewReport): Promise<Report> {
      return { id: crypto.randomUUID(), gradeId: input.gradeId, token: input.token, createdAt: new Date() }
    },
    async getReport(_gradeId: string): Promise<Report | null> { return null },
  }
}
