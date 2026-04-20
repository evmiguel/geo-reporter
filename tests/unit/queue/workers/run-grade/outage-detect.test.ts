import { describe, it, expect } from 'vitest'
import { makeFakeStore } from '../../../_helpers/fake-store.ts'
import { detectClaudeOrOpenAIOutage } from '../../../../../src/queue/workers/run-grade/outage-detect.ts'

describe('detectClaudeOrOpenAIOutage', () => {
  it('returns null when no terminal failures exist', async () => {
    const store = makeFakeStore()
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie: 'c', userId: null, status: 'running',
    })
    await store.createProbe({
      gradeId: grade.id, category: 'discoverability', provider: 'claude',
      prompt: 'p', response: 'r', score: 50, metadata: {},
    })
    expect(await detectClaudeOrOpenAIOutage(grade.id, store)).toBeNull()
  })

  it('returns an object with a message when Claude terminal-failed', async () => {
    const store = makeFakeStore()
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free',
      cookie: 'c', userId: null, status: 'running',
    })
    await store.createProbe({
      gradeId: grade.id, category: 'discoverability', provider: 'claude',
      prompt: '', response: '', score: null, metadata: { error: 'Anthropic 500' },
    })
    const result = await detectClaudeOrOpenAIOutage(grade.id, store)
    expect(result).not.toBeNull()
    expect(result!.message).toMatch(/provider/i)
  })
})
