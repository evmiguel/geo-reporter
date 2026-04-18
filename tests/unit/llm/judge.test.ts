import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { runJudge } from '../../../src/llm/judge.ts'
import type { ProbeForJudge } from '../../../src/llm/ground-truth.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme Widgets — the world\'s largest widget maker',
  description: 'We have been making widgets since 1902 in Springfield, serving millions of customers worldwide.',
  h1: 'Industrial widgets built to last',
  bodyExcerpt: 'Four generations of family ownership; A-100 and A-200 flagship products.',
}

const PROBES: ProbeForJudge[] = [
  { key: 'probe_1', provider: 'claude', category: 'coverage', prompt: 'Q1', response: 'R1' },
  { key: 'probe_2', provider: 'gpt', category: 'coverage', prompt: 'Q2', response: 'R2' },
]

const GOOD_JSON = JSON.stringify({
  probe_1: { accuracy: 85, coverage: 80, notes: 'solid' },
  probe_2: { accuracy: 70, coverage: 75, notes: 'ok' },
})

describe('runJudge', () => {
  it('parses raw JSON body and returns per-probe + per-provider', async () => {
    const judge = new MockProvider({ id: 'claude', responses: () => GOOD_JSON })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(false)
    expect(result.perProbe.get('probe_1')?.accuracy).toBe(85)
    expect(result.perProvider.claude?.accuracy).toBe(85)
    expect(result.perProvider.gpt?.coverage).toBe(75)
  })

  it('parses JSON wrapped in fenced code block', async () => {
    const judge = new MockProvider({ id: 'claude', responses: () => '```json\n' + GOOD_JSON + '\n```' })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(false)
    expect(result.perProvider.claude?.accuracy).toBe(85)
  })

  it('parses JSON via first-brace to last-brace substring', async () => {
    const judge = new MockProvider({ id: 'claude', responses: () => `Here is the result:\n${GOOD_JSON}\nDone.` })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(false)
  })

  it('descends one level for { scores: {...} } wrapper', async () => {
    const judge = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({
        scores: {
          probe_1: { accuracy: 90, coverage: 90, notes: 'great' },
          probe_2: { accuracy: 85, coverage: 85, notes: 'good' },
        },
      }),
    })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(false)
    expect(result.perProvider.claude?.accuracy).toBe(90)
  })

  it('retries with a stricter prompt when first response is unparseable', async () => {
    let call = 0
    const judge = new MockProvider({
      id: 'claude',
      responses: () => {
        call++
        return call === 1 ? 'not json at all' : GOOD_JSON
      },
    })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(call).toBe(2)
    expect(result.degraded).toBe(false)
    expect(result.perProvider.claude?.accuracy).toBe(85)
  })

  it('falls back to heuristic (degraded:true) after both tries fail', async () => {
    const judge = new MockProvider({ id: 'claude', responses: () => 'no json here either' })
    const result = await runJudge({ judge, groundTruth: GT, probes: PROBES })
    expect(result.degraded).toBe(true)
    expect(result.perProbe.size).toBe(0)
    expect(result.perProvider.claude).toBeDefined()
    expect(result.perProvider.gpt).toBeDefined()
  })

  it('aggregates multiple probes per provider with averages', async () => {
    const probes: ProbeForJudge[] = [
      { key: 'probe_1', provider: 'claude', category: 'coverage', prompt: 'Q', response: 'R' },
      { key: 'probe_2', provider: 'claude', category: 'coverage', prompt: 'Q', response: 'R' },
    ]
    const body = JSON.stringify({
      probe_1: { accuracy: 90, coverage: 80, notes: 'a' },
      probe_2: { accuracy: 70, coverage: 60, notes: 'b' },
    })
    const judge = new MockProvider({ id: 'claude', responses: () => body })
    const result = await runJudge({ judge, groundTruth: GT, probes })
    expect(result.perProvider.claude?.accuracy).toBe(80)
    expect(result.perProvider.claude?.coverage).toBe(70)
    expect(result.perProvider.claude?.notes).toBe('a | b')
  })

  it('uses the sparse branch when ground truth is sparse', async () => {
    const sparseGT = { url: 'https://a.com', domain: 'a.com', title: 'A', description: '', h1: '', bodyExcerpt: '' }
    const seen: string[] = []
    const judge = new MockProvider({
      id: 'claude',
      responses: (prompt) => { seen.push(prompt); return GOOD_JSON },
    })
    await runJudge({ judge, groundTruth: sparseGT, probes: PROBES })
    expect(seen[0]).toContain('scrape is essentially empty')
  })
})
