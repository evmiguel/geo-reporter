import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../../src/llm/providers/mock.ts'
import { runSelfGenProbe } from '../../../../src/llm/flows/self-gen.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme', description: 'Widgets', h1: 'Hi', bodyExcerpt: 'body',
}

describe('runSelfGenProbe', () => {
  it('runs stage1 to get a question, then stage2 with that question on same provider', async () => {
    const calls: string[] = []
    const provider = new MockProvider({
      id: 'claude',
      responses: (prompt) => {
        calls.push(prompt)
        return prompt.includes('Do NOT reference')
          ? 'What is the best widget maker?'
          : 'Acme is the best widget maker.'
      },
    })
    const result = await runSelfGenProbe({
      provider,
      groundTruth: GT,
      scorer: ({ text }) => (text.toLowerCase().includes('acme') ? 100 : 0),
    })
    expect(calls).toHaveLength(2)
    expect(result.generator.response).toBe('What is the best widget maker?')
    expect(result.probe.prompt).toBe('What is the best widget maker?')
    expect(result.probe.response).toBe('Acme is the best widget maker.')
    expect(result.score).toBe(100)
  })

  it('throws if stage 1 throws', async () => {
    const provider = new MockProvider({ id: 'claude', responses: {}, failWith: 'stage1 down' })
    await expect(runSelfGenProbe({ provider, groundTruth: GT, scorer: () => 50 })).rejects.toThrow('stage1 down')
  })

  it('throws if stage 2 throws', async () => {
    let call = 0
    const provider = new MockProvider({
      id: 'claude',
      responses: (prompt) => {
        call++
        if (call === 1) return 'generated Q'
        throw new Error('stage2 down')
      },
    })
    await expect(runSelfGenProbe({ provider, groundTruth: GT, scorer: () => 50 })).rejects.toThrow()
  })

  it('passes brand + domain to scorer', async () => {
    let scorerArgs: { text: string; brand: string; domain: string } | null = null
    const provider = new MockProvider({
      id: 'claude',
      responses: (prompt) => (prompt.includes('Do NOT reference') ? 'Q' : 'A'),
    })
    await runSelfGenProbe({
      provider,
      groundTruth: { ...GT, domain: 'stripe.com' },
      scorer: (args) => {
        scorerArgs = args
        return 1
      },
    })
    expect(scorerArgs).not.toBeNull()
    expect(scorerArgs!.brand).toBe('Stripe')
    expect(scorerArgs!.domain).toBe('stripe.com')
    expect(scorerArgs!.text).toBe('A')
  })

  it('includes generator and probe token + latency data', async () => {
    const provider = new MockProvider({
      id: 'claude',
      responses: (prompt) => (prompt.includes('Do NOT') ? 'gen' : 'probe'),
      latencyMs: 5,
    })
    const r = await runSelfGenProbe({ provider, groundTruth: GT, scorer: () => 10 })
    expect(r.generator.latencyMs).toBe(5)
    expect(r.probe.latencyMs).toBe(5)
    expect(r.generator.inputTokens).toBeGreaterThan(0)
    expect(r.probe.outputTokens).toBeGreaterThan(0)
  })
})
