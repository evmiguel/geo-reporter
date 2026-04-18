import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { runCoverageFlow } from '../../../../src/llm/flows/coverage.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme Widgets', description: 'We sell widgets since 1902.', h1: 'Welcome',
  bodyExcerpt: 'Four generations of family ownership. We make widgets worldwide across many construction sites for customers everywhere.',
}

const JUDGE_JSON = JSON.stringify({
  probe_1: { accuracy: 80, coverage: 75, notes: 'c' },
  probe_2: { accuracy: 70, coverage: 65, notes: 'g' },
  probe_3: { accuracy: 75, coverage: 70, notes: 'c2' },
  probe_4: { accuracy: 65, coverage: 60, notes: 'g2' },
})

describe('runCoverageFlow', () => {
  it('runs all coverage prompts across providers and calls the judge', async () => {
    const claude = new MockProvider({ id: 'claude', responses: () => 'claude answer' })
    const gpt = new MockProvider({ id: 'gpt', responses: () => 'gpt answer' })
    const judge = new MockProvider({ id: 'claude', responses: () => JUDGE_JSON })
    const result = await runCoverageFlow({ providers: [claude, gpt], judge, groundTruth: GT })
    expect(result.probes).toHaveLength(4)
    expect(result.probes.map((p) => p.provider).sort()).toEqual(['claude', 'claude', 'gpt', 'gpt'])
    expect(result.judge.degraded).toBe(false)
  })

  it('works with 4 providers (paid tier)', async () => {
    const judge = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify(Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`probe_${i + 1}`, { accuracy: 80, coverage: 70, notes: '' }]),
      )),
    })
    const providers = [
      new MockProvider({ id: 'claude', responses: () => 'a' }),
      new MockProvider({ id: 'gpt', responses: () => 'a' }),
      new MockProvider({ id: 'gemini', responses: () => 'a' }),
      new MockProvider({ id: 'perplexity', responses: () => 'a' }),
    ]
    const result = await runCoverageFlow({ providers, judge, groundTruth: GT })
    expect(result.probes).toHaveLength(8)
  })

  it('records per-probe errors without aborting the flow', async () => {
    const claude = new MockProvider({ id: 'claude', responses: () => 'ok' })
    const gpt = new MockProvider({ id: 'gpt', responses: {}, failWith: 'rate limited' })
    const judge = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({
        probe_1: { accuracy: 80, coverage: 70, notes: '' },
        probe_2: { accuracy: 75, coverage: 65, notes: '' },
      }),
    })
    const result = await runCoverageFlow({ providers: [claude, gpt], judge, groundTruth: GT })
    const gptProbes = result.probes.filter((p) => p.provider === 'gpt')
    expect(gptProbes).toHaveLength(2)
    expect(gptProbes.every((p) => p.error !== null)).toBe(true)
    expect(gptProbes.every((p) => p.response === '')).toBe(true)
  })

  it('returns degraded judge when all probes fail', async () => {
    const p = new MockProvider({ id: 'claude', responses: {}, failWith: 'down' })
    const judge = new MockProvider({ id: 'claude', responses: () => 'not reached' })
    const result = await runCoverageFlow({ providers: [p], judge, groundTruth: GT })
    expect(result.probes.every((x) => x.error !== null)).toBe(true)
    expect(result.judge.degraded).toBe(true)
  })
})
