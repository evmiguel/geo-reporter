import type { Probe, ReportRecord } from '../store/types.ts'
import type {
  AccuracyProbe, AccuracyRow, CategoryId, LlmAnswer, ModelSnapshot, ProbeGroup,
  ProviderId, RecommendationCard, ReportInput, ScorecardCategory, SeoSignal,
} from './types.ts'
import { friendlyModelName } from './model-names.ts'

const CATEGORY_ORDER: CategoryId[] = ['discoverability', 'recognition', 'accuracy', 'coverage', 'citation', 'seo']
const CATEGORY_LABEL: Record<CategoryId, string> = {
  discoverability: 'Discoverability', recognition: 'Recognition', accuracy: 'Accuracy',
  coverage: 'Coverage', citation: 'Citation', seo: 'SEO',
}
const CATEGORY_WEIGHT: Record<CategoryId, number> = {
  discoverability: 30, recognition: 20, accuracy: 20, coverage: 10, citation: 10, seo: 10,
}
const CATEGORY_SUMMARY: Record<CategoryId, (score: number | null) => string> = {
  discoverability: (s) => s === null ? 'Not measured.' : s >= 80 ? 'LLMs can reliably find you via the usual queries.' : s >= 60 ? 'LLMs find you sometimes, miss you often.' : 'LLMs rarely surface you for relevant queries.',
  recognition: (s) => s === null ? 'Not measured.' : s >= 80 ? 'Your brand name is correctly associated with your category.' : s >= 60 ? 'Mixed recognition — LLMs sometimes confuse you.' : 'Poor brand-to-category recognition.',
  accuracy: (s) => s === null ? 'Not measured.' : s >= 80 ? 'LLMs state facts that match your site.' : s >= 60 ? 'Mixed. LLMs know some facts but invent others.' : 'LLMs frequently fabricate facts about you.',
  coverage: (s) => s === null ? 'Not measured.' : s >= 80 ? 'LLMs know your site in depth.' : s >= 60 ? 'LLMs know the main pages but miss deeper content.' : 'LLMs have only shallow coverage of your site.',
  citation: (s) => s === null ? 'Not measured.' : s >= 80 ? 'LLMs correctly cite your domain as the source.' : s >= 60 ? 'LLMs cite you inconsistently.' : 'LLMs rarely cite your domain.',
  seo: (s) => s === null ? 'Not measured.' : s >= 80 ? 'Most signals pass.' : s >= 60 ? 'Some signals fail — see findings.' : 'Many signals fail — see findings.',
}
const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', perplexity: 'Perplexity', mock: 'Mock',
}

function metaString(p: Probe, key: string): string | null {
  const v = (p.metadata as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}
function metaBool(p: Probe, key: string): boolean | null {
  const v = (p.metadata as Record<string, unknown>)[key]
  return typeof v === 'boolean' ? v : null
}
function metaModel(p: Probe): string {
  return metaString(p, 'model') ?? 'unknown'
}

export function buildReportInput(record: ReportRecord): ReportInput {
  const { grade, probes, recommendations, report } = record
  const scores = (grade.scores as Record<string, number | null> | null) ?? {}

  const scorecard: ScorecardCategory[] = CATEGORY_ORDER.map((id) => ({
    id, label: CATEGORY_LABEL[id], weight: CATEGORY_WEIGHT[id],
    score: scores[id] ?? null, summary: CATEGORY_SUMMARY[id](scores[id] ?? null),
  }))

  const rawResponsesByProbe = buildRawResponseGroups(probes)
  const accuracyProbes = buildAccuracyProbes(probes)
  const seoFindings = buildSeoFindings(probes)

  const recCards: RecommendationCard[] = recommendations
    .map((r) => ({
      rank: r.rank, category: r.category, title: r.title,
      impact: r.impact, effort: r.effort, priority: r.impact * (6 - r.effort),
      rationale: r.rationale, how: r.how,
    }))
    .sort((a, b) => b.priority - a.priority)

  const models = aggregateModels(probes)

  return {
    generatedAt: new Date(),
    grade: {
      id: grade.id, url: grade.url, domain: grade.domain,
      overall: grade.overall, letter: grade.letter,
      scores: grade.scores, createdAt: grade.createdAt,
    },
    reportId: report.id,
    scorecard, rawResponsesByProbe, accuracyProbes, seoFindings,
    recommendations: recCards, models,
  }
}

function buildRawResponseGroups(probes: Probe[]): ProbeGroup[] {
  const withProvider = probes.filter((p) => p.provider !== null && p.category !== 'seo' && p.category !== 'accuracy')
  const groups = new Map<string, ProbeGroup>()
  for (const probe of withProvider) {
    const key = `${probe.category}|${probe.prompt}`
    const existing = groups.get(key)
    const answer: LlmAnswer = {
      providerId: probe.provider as ProviderId,
      providerLabel: PROVIDER_LABEL[probe.provider as ProviderId] ?? probe.provider ?? '',
      modelId: metaModel(probe),
      modelLabel: friendlyModelName(metaModel(probe)),
      response: probe.response, score: probe.score,
    }
    if (existing) existing.answers.push(answer)
    else groups.set(key, { category: probe.category as CategoryId, question: probe.prompt, answers: [answer] })
  }
  return [...groups.values()]
}

function buildAccuracyProbes(probes: Probe[]): AccuracyProbe[] {
  const accuracyProbes = probes.filter((p) => p.category === 'accuracy')
  // Generators and verifies are distinguished by metadata.role, NOT by
  // provider — the generator runs through Claude (or whichever provider
  // the accuracy flow chose) and stamps a real provider ID on its probe
  // row. An older filter here keyed on `provider === null` and found
  // zero generators, which collapsed the appendix to the empty-state
  // fallback on every paid report.
  const generators = accuracyProbes.filter((p) => metaString(p, 'role') === 'generator')
  const verifies = accuracyProbes.filter((p) => metaString(p, 'role') === 'verify')

  return generators.map((gen): AccuracyProbe => {
    const question = gen.response
    // Prefer the metadata.generatorProbeId foreign key the writer stamps
    // on each verify row; fall back to prompt-string equality for old
    // data that predates that field.
    const rows: AccuracyRow[] = verifies
      .filter((v) => {
        const fk = metaString(v, 'generatorProbeId')
        return fk !== null ? fk === gen.id : v.prompt === question
      })
      .map((v) => ({
        providerId: v.provider as ProviderId,
        providerLabel: PROVIDER_LABEL[v.provider as ProviderId] ?? v.provider ?? '',
        answer: v.response,
        ruling: v.score === 100 ? 'correct' : v.score === 0 ? 'wrong' : v.score === null ? 'unknown' : 'partial',
        rationale: metaString(v, 'rationale'),
      }))
    const correctCount = rows.filter((r) => r.ruling === 'correct').length
    const summary = `${correctCount} of ${rows.length} correct.`
    return { question, truth: '', rows, summary }
  })
}

function buildSeoFindings(probes: Probe[]): SeoSignal[] {
  return probes
    .filter((p) => p.category === 'seo')
    .map((p): SeoSignal => {
      const label = metaString(p, 'signal') ?? metaString(p, 'label') ?? 'signal'
      const pass = metaBool(p, 'pass') ?? ((p.score ?? 0) >= 100)
      return { label, pass, detail: p.response }
    })
}

function aggregateModels(probes: Probe[]): ModelSnapshot[] {
  const seen = new Set<string>()
  const out: ModelSnapshot[] = []
  for (const p of probes) {
    if (p.provider === null) continue
    const model = metaString(p, 'model')
    if (!model) continue
    const key = `${p.provider}:${model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ providerId: p.provider as ProviderId, modelId: model })
  }
  return out
}
