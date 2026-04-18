import { promptJudge } from './prompts.ts'
import type { GroundTruth, ProbeForJudge } from './ground-truth.ts'
import type { Provider, ProviderId, QueryOpts } from './providers/types.ts'

export interface ProbeJudgement {
  accuracy: number
  coverage: number
  notes: string
}

export interface JudgeResult {
  prompt: string
  rawResponse: string
  perProbe: Map<string, ProbeJudgement>
  perProvider: Partial<Record<ProviderId, ProbeJudgement>>
  degraded: boolean
}

export interface RunJudgeInput {
  judge: Provider
  groundTruth: GroundTruth
  probes: ProbeForJudge[]
  signal?: AbortSignal
}

export async function runJudge(input: RunJudgeInput): Promise<JudgeResult> {
  const { judge, groundTruth, probes, signal } = input
  const built = promptJudge(groundTruth, probes)
  const baseOpts: QueryOpts = { temperature: 0 }
  if (signal !== undefined) baseOpts.signal = signal

  let response = await judge.query(built.prompt, baseOpts)
  let perProbe = tryParse(response.text, built.probesByKey)

  if (!perProbe) {
    const stricter = `${built.prompt}\n\nIMPORTANT: Respond with ONLY a JSON object, no prose, no code fences, no preamble.`
    response = await judge.query(stricter, baseOpts)
    perProbe = tryParse(response.text, built.probesByKey)
  }

  if (!perProbe) {
    return {
      prompt: built.prompt,
      rawResponse: response.text,
      perProbe: new Map(),
      perProvider: heuristicFallback(probes, groundTruth),
      degraded: true,
    }
  }

  return {
    prompt: built.prompt,
    rawResponse: response.text,
    perProbe,
    perProvider: aggregateByProvider(perProbe, built.probesByKey),
    degraded: false,
  }
}

function tryParse(
  text: string,
  probesByKey: Map<string, ProbeForJudge>,
): Map<string, ProbeJudgement> | null {
  const candidates: string[] = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1])
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s !== -1 && e > s) candidates.push(text.slice(s, e + 1))

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim())
      if (!parsed || typeof parsed !== 'object') continue
      const top = normalize(parsed as Record<string, unknown>, probesByKey)
      if (top.size > 0) return top
      for (const v of Object.values(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue
        const nested = normalize(v as Record<string, unknown>, probesByKey)
        if (nested.size > 0) return nested
      }
    } catch { /* try next candidate */ }
  }
  return null
}

function normalize(
  raw: Record<string, unknown>,
  probesByKey: Map<string, ProbeForJudge>,
): Map<string, ProbeJudgement> {
  const out = new Map<string, ProbeJudgement>()
  for (const [key, value] of Object.entries(raw)) {
    if (!probesByKey.has(key.trim())) continue
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (typeof v['accuracy'] !== 'number' && typeof v['coverage'] !== 'number') continue
    out.set(key.trim(), {
      accuracy: typeof v['accuracy'] === 'number' ? v['accuracy'] : 0,
      coverage: typeof v['coverage'] === 'number' ? v['coverage'] : 0,
      notes: typeof v['notes'] === 'string' ? v['notes'] : '',
    })
  }
  return out
}

function aggregateByProvider(
  perProbe: Map<string, ProbeJudgement>,
  probesByKey: Map<string, ProbeForJudge>,
): Partial<Record<ProviderId, ProbeJudgement>> {
  const buckets: Partial<Record<ProviderId, ProbeJudgement[]>> = {}
  for (const [key, probe] of probesByKey) {
    const judgement = perProbe.get(key)
    if (!judgement) continue
    const bucket = buckets[probe.provider] ?? []
    bucket.push(judgement)
    buckets[probe.provider] = bucket
  }
  const out: Partial<Record<ProviderId, ProbeJudgement>> = {}
  for (const [provider, list] of Object.entries(buckets) as [ProviderId, ProbeJudgement[]][]) {
    if (!list || list.length === 0) continue
    const accuracy = Math.round(list.reduce((s, j) => s + j.accuracy, 0) / list.length)
    const coverage = Math.round(list.reduce((s, j) => s + j.coverage, 0) / list.length)
    const notes = list.map((j) => j.notes).filter(Boolean).join(' | ')
    out[provider] = { accuracy, coverage, notes }
  }
  return out
}

function heuristicFallback(
  probes: ProbeForJudge[],
  gt: GroundTruth,
): Partial<Record<ProviderId, ProbeJudgement>> {
  const truth = tokenize(`${gt.title} ${gt.description} ${gt.h1} ${gt.bodyExcerpt}`)
  const BASELINE = 60
  const out: Partial<Record<ProviderId, ProbeJudgement>> = {}
  for (const probe of probes) {
    if (!probe.response || probe.response.length === 0) continue
    const words = tokenize(probe.response)
    let overlap = 0
    for (const w of words) if (truth.has(w)) overlap++
    const bonus = Math.min(20, Math.round((overlap / Math.max(1, words.size)) * 200))
    const score = Math.min(100, BASELINE + bonus)
    out[probe.provider] = {
      accuracy: score,
      coverage: score,
      notes: 'fallback (judge parse failed)',
    }
  }
  return out
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3),
  )
}
