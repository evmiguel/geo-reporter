import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../../src/llm/providers/mock.ts'
import { verifyAnswer } from '../../../src/accuracy/verifier.ts'

const GT = {
  url: 'https://acme.com', domain: 'acme.com',
  title: 'Acme', description: 'Widgets since 1902.', h1: 'Welcome',
  bodyExcerpt: 'Acme was founded in 1902 in Springfield.',
}

const ANSWER = {
  providerId: 'claude' as const,
  answer: 'Acme was founded in 1902.',
  latencyMs: 10, inputTokens: 5, outputTokens: 7, error: null,
}

describe('verifyAnswer', () => {
  it('parses correct:true JSON', async () => {
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: true, confidence: 0.9, rationale: 'matches scrape' }),
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'When was Acme founded?', probeAnswer: ANSWER })
    expect(r.correct).toBe(true)
    expect(r.confidence).toBe(0.9)
    expect(r.rationale).toBe('matches scrape')
    expect(r.degraded).toBe(false)
  })

  it('parses correct:false JSON', async () => {
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: false, confidence: 0.95, rationale: 'wrong year' }),
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(r.correct).toBe(false)
  })

  it('parses correct:null JSON', async () => {
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => JSON.stringify({ correct: null, confidence: 0.1, rationale: 'scrape does not say' }),
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(r.correct).toBe(null)
  })

  it('parses JSON inside a fenced code block', async () => {
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => '```json\n{"correct":true,"confidence":0.8,"rationale":"ok"}\n```',
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(r.correct).toBe(true)
  })

  it('retries with stricter prompt on first parse failure', async () => {
    let call = 0
    const verifier = new MockProvider({
      id: 'claude',
      responses: () => {
        call++
        return call === 1 ? 'not json' : JSON.stringify({ correct: true, confidence: 0.5, rationale: 'x' })
      },
    })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(call).toBe(2)
    expect(r.correct).toBe(true)
    expect(r.degraded).toBe(false)
  })

  it('returns degraded result when JSON cannot be parsed after retry', async () => {
    const verifier = new MockProvider({ id: 'claude', responses: () => 'still not json' })
    const r = await verifyAnswer({ verifier, groundTruth: GT, question: 'q', probeAnswer: ANSWER })
    expect(r.degraded).toBe(true)
    expect(r.correct).toBe(null)
    expect(r.confidence).toBe(0)
  })
})
