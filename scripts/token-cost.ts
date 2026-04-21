#!/usr/bin/env tsx
/**
 * Print token counts + estimated LLM cost for a grade.
 *
 * Reads probe rows and sums metadata.inputTokens / metadata.outputTokens
 * grouped by provider. Applies a hard-coded price table (verify against
 * the provider's current pricing before using this as anything but a rough
 * estimate).
 *
 * Usage (local dev DB):
 *   pnpm tsx --env-file=.env scripts/token-cost.ts <gradeId>
 *   pnpm tsx --env-file=.env scripts/token-cost.ts --recent         # last 1
 *   pnpm tsx --env-file=.env scripts/token-cost.ts --recent 10
 *
 * Usage (prod DB from your laptop — SELECT-only, safe):
 *   DATABASE_URL=<prod-url> pnpm tsx scripts/token-cost.ts <gradeId>
 *
 * Scope: covers the run-grade pass (all six categories + accuracy).
 * The /billing/generate-report pass (report recommendations) is NOT
 * tracked here — it doesn't write probe rows. If you need that cost,
 * instrument the generate-report worker separately.
 */

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { ProviderId } from '../src/llm/providers/types.ts'

// Bypass src/config/env.ts on purpose — it demands REDIS_URL even for
// read-only scripts. We only need DATABASE_URL here.
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required. Pass it inline:')
  console.error('  DATABASE_URL=<url> pnpm tsx scripts/token-cost.ts <gradeId>')
  process.exit(1)
}

const pg = postgres(DATABASE_URL, { prepare: false, max: 2 })
const db = drizzle(pg)
async function closeDb(): Promise<void> { await pg.end({ timeout: 5 }) }

// Prices in USD per 1M tokens. As of 2026-04-21.
// Verify at the provider's pricing page before trusting these for
// anything tighter than an order-of-magnitude estimate.
const PRICES: Record<ProviderId, { inputPer1M: number; outputPer1M: number }> = {
  claude:     { inputPer1M: 3.00,  outputPer1M: 15.00 },  // Sonnet 4.6
  gpt:        { inputPer1M: 0.40,  outputPer1M: 1.60 },   // GPT-4.1 mini
  gemini:     { inputPer1M: 0.075, outputPer1M: 0.30 },   // Gemini 2.5 Flash
  perplexity: { inputPer1M: 1.00,  outputPer1M: 1.00 },   // Sonar (approx)
  mock:       { inputPer1M: 0,     outputPer1M: 0 },
}

interface ProbeRow {
  grade_id: string
  provider: string | null
  input_tokens: number | null
  output_tokens: number | null
}

interface GradeRow {
  id: string
  url: string
  tier: string
  status: string
  created_at: Date
  paid: boolean
}

interface ProviderTotal {
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

async function resolveGradeIds(): Promise<string[]> {
  const args = process.argv.slice(2)
  const recentIdx = args.indexOf('--recent')

  if (recentIdx >= 0) {
    const nRaw = args[recentIdx + 1]
    const n = nRaw && /^\d+$/.test(nRaw) ? Number(nRaw) : 1
    const rows = await db.execute(sql`
      SELECT id FROM grades
      WHERE status = 'done'
      ORDER BY created_at DESC
      LIMIT ${n}
    `)
    return rows.map((r) => (r as { id: string }).id)
  }

  const explicit = args.find((a) => !a.startsWith('--'))
  if (!explicit) {
    console.error('Usage: token-cost.ts <gradeId>  OR  --recent [N]')
    process.exit(1)
  }
  return [explicit]
}

async function fetchGradeHeader(gradeId: string): Promise<GradeRow | null> {
  const rows = await db.execute(sql`
    SELECT
      g.id, g.url, g.tier, g.status, g.created_at,
      EXISTS (
        SELECT 1 FROM stripe_payments p
        WHERE p.grade_id = g.id AND p.status = 'paid'
      ) AS paid
    FROM grades g
    WHERE g.id = ${gradeId}
  `)
  if (rows.length === 0) return null
  const r = rows[0] as unknown as GradeRow
  return r
}

async function fetchProbes(gradeId: string): Promise<ProbeRow[]> {
  const rows = await db.execute(sql`
    SELECT
      p.grade_id,
      p.provider,
      (p.metadata ->> 'inputTokens')::int AS input_tokens,
      (p.metadata ->> 'outputTokens')::int AS output_tokens
    FROM probes p
    WHERE p.grade_id = ${gradeId}
  `)
  return rows as unknown as ProbeRow[]
}

function totalsByProvider(probes: ProbeRow[]): Map<string, ProviderTotal> {
  const byProv = new Map<string, ProviderTotal>()
  for (const p of probes) {
    if (p.input_tokens === null || p.output_tokens === null) continue
    const key = p.provider ?? 'unknown'
    const cur = byProv.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    cur.calls += 1
    cur.inputTokens += p.input_tokens
    cur.outputTokens += p.output_tokens
    const price = PRICES[key as ProviderId]
    if (price) {
      cur.costUsd += (p.input_tokens * price.inputPer1M + p.output_tokens * price.outputPer1M) / 1_000_000
    }
    byProv.set(key, cur)
  }
  return byProv
}

function fmt(n: number, width: number): string {
  return String(n.toLocaleString()).padStart(width)
}

function printGrade(grade: GradeRow, probes: ProbeRow[]): { totalUsd: number; totalCalls: number } {
  const probesWithTokens = probes.filter((p) => p.input_tokens !== null)
  const missing = probes.length - probesWithTokens.length

  console.log('')
  console.log(`Grade:   ${grade.id}`)
  console.log(`URL:     ${grade.url}`)
  console.log(`Tier:    ${grade.tier}   Status: ${grade.status}   Paid: ${grade.paid ? 'yes' : 'no'}`)
  console.log(`Created: ${new Date(grade.created_at).toISOString()}`)
  console.log('')

  if (probes.length === 0) {
    console.log('  No probe rows.')
    return { totalUsd: 0, totalCalls: 0 }
  }

  const totals = totalsByProvider(probes)
  console.log('  Provider      Calls   Input tokens   Output tokens        Cost')
  console.log('  ────────────────────────────────────────────────────────────────')
  let grandUsd = 0
  let grandCalls = 0
  for (const [prov, t] of [...totals.entries()].sort()) {
    console.log(`  ${prov.padEnd(12)} ${fmt(t.calls, 6)}   ${fmt(t.inputTokens, 12)}   ${fmt(t.outputTokens, 13)}    ${('$' + t.costUsd.toFixed(4)).padStart(8)}`)
    grandUsd += t.costUsd
    grandCalls += t.calls
  }
  console.log('  ────────────────────────────────────────────────────────────────')
  console.log(`  Total        ${fmt(grandCalls, 6)}${' '.repeat(48)}${('$' + grandUsd.toFixed(4)).padStart(8)}`)
  if (missing > 0) {
    console.log(`  (${missing} probe row${missing === 1 ? '' : 's'} had no token metadata — pre-instrumentation or error path; excluded from totals)`)
  }
  return { totalUsd: grandUsd, totalCalls: grandCalls }
}

async function main(): Promise<void> {
  const ids = await resolveGradeIds()

  let sumUsd = 0
  let sumCalls = 0
  let sumGrades = 0
  for (const id of ids) {
    const grade = await fetchGradeHeader(id)
    if (!grade) {
      console.error(`Grade ${id} not found — skipping.`)
      continue
    }
    const probes = await fetchProbes(id)
    const { totalUsd, totalCalls } = printGrade(grade, probes)
    sumUsd += totalUsd
    sumCalls += totalCalls
    sumGrades += 1
  }

  if (sumGrades > 1) {
    console.log('')
    console.log('══════════════════════════════════════════════════════════')
    console.log(`Summary: ${sumGrades} grades, ${sumCalls} LLM calls, $${sumUsd.toFixed(4)} total`)
    console.log(`Per-grade avg: $${(sumUsd / sumGrades).toFixed(4)}   ${(sumCalls / sumGrades).toFixed(1)} calls`)
    console.log('══════════════════════════════════════════════════════════')
  }

  await closeDb()
  process.exit(0)
}

main().catch((err) => {
  console.error('token-cost crashed:', err)
  process.exit(1)
})
