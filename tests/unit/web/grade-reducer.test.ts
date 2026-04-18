import { describe, expect, it } from 'vitest'
import { initialGradeState, reduceGradeEvents } from '../../../src/web/lib/grade-reducer.ts'
import type { GradeEvent } from '../../../src/web/lib/types.ts'

const NOW = 1_700_000_000_000

describe('reduceGradeEvents', () => {
  it('initial state has phase=queued, empty probes, all categoryScores null', () => {
    const s = initialGradeState()
    expect(s.phase).toBe('queued')
    expect(s.probes.size).toBe(0)
    expect(s.categoryScores.discoverability).toBeNull()
    expect(s.overall).toBeNull()
    expect(s.error).toBeNull()
  })

  it('running event flips phase to running', () => {
    const s = reduceGradeEvents(initialGradeState(), { type: 'running' }, NOW)
    expect(s.phase).toBe('running')
  })

  it('scraped event sets phase + scraped metadata', () => {
    const s = reduceGradeEvents(initialGradeState(), { type: 'scraped', rendered: true, textLength: 1234 }, NOW)
    expect(s.phase).toBe('scraped')
    expect(s.scraped).toEqual({ rendered: true, textLength: 1234 })
  })

  it('probe.started adds a probe with status=started', () => {
    const s = reduceGradeEvents(initialGradeState(), {
      type: 'probe.started', category: 'seo', provider: null, label: 'title',
    }, NOW)
    expect(s.probes.size).toBe(1)
    const probe = s.probes.get('seo:-:title')
    expect(probe?.status).toBe('started')
    expect(probe?.startedAt).toBe(NOW)
  })

  it('probe.completed after probe.started upgrades the entry in place', () => {
    let s = initialGradeState()
    s = reduceGradeEvents(s, { type: 'probe.started', category: 'recognition', provider: 'claude', label: 'prompt_1' }, NOW)
    s = reduceGradeEvents(s, {
      type: 'probe.completed', category: 'recognition', provider: 'claude', label: 'prompt_1',
      score: 85, durationMs: 1200, error: null,
    }, NOW + 1200)
    expect(s.probes.size).toBe(1)
    const probe = s.probes.get('recognition:claude:prompt_1')
    expect(probe?.status).toBe('completed')
    expect(probe?.score).toBe(85)
    expect(probe?.durationMs).toBe(1200)
    expect(probe?.startedAt).toBe(NOW) // preserves original startedAt
  })

  it('probe.completed without prior started (hydrated replay) adds a completed entry', () => {
    const s = reduceGradeEvents(initialGradeState(), {
      type: 'probe.completed', category: 'citation', provider: 'gpt', label: 'official-url',
      score: 50, durationMs: 800, error: null,
    }, NOW)
    expect(s.probes.size).toBe(1)
    expect(s.probes.get('citation:gpt:official-url')?.status).toBe('completed')
  })

  it('duplicate probe.completed for same key is idempotent', () => {
    let s = initialGradeState()
    const event: GradeEvent = {
      type: 'probe.completed', category: 'seo', provider: null, label: 'canonical',
      score: 100, durationMs: 0, error: null,
    }
    s = reduceGradeEvents(s, event, NOW)
    s = reduceGradeEvents(s, event, NOW + 100)
    expect(s.probes.size).toBe(1)
  })

  it('category.completed updates only the named category', () => {
    let s = initialGradeState()
    s = reduceGradeEvents(s, { type: 'category.completed', category: 'seo', score: 90 }, NOW)
    expect(s.categoryScores.seo).toBe(90)
    expect(s.categoryScores.recognition).toBeNull()
    s = reduceGradeEvents(s, { type: 'category.completed', category: 'recognition', score: 75 }, NOW)
    expect(s.categoryScores.recognition).toBe(75)
    expect(s.categoryScores.seo).toBe(90)
  })

  it('done event flips phase + sets overall/letter and overwrites categoryScores', () => {
    let s = initialGradeState()
    s = reduceGradeEvents(s, { type: 'category.completed', category: 'seo', score: 90 }, NOW)
    s = reduceGradeEvents(s, {
      type: 'done', overall: 78, letter: 'C+',
      scores: { discoverability: 80, recognition: 75, accuracy: 60, coverage: 70, citation: 100, seo: 80 },
    }, NOW)
    expect(s.phase).toBe('done')
    expect(s.overall).toBe(78)
    expect(s.letter).toBe('C+')
    // done event overwrites categoryScores with the authoritative map
    expect(s.categoryScores.seo).toBe(80)
  })

  it('failed event sets phase + error', () => {
    const s = reduceGradeEvents(initialGradeState(), { type: 'failed', error: 'scrape too short' }, NOW)
    expect(s.phase).toBe('failed')
    expect(s.error).toBe('scrape too short')
  })

  it('full lifecycle: running → scraped → probes → done ends in correct shape', () => {
    let s = initialGradeState()
    s = reduceGradeEvents(s, { type: 'running' }, NOW)
    s = reduceGradeEvents(s, { type: 'scraped', rendered: false, textLength: 3000 }, NOW + 100)

    const sequences: Array<{ cat: 'seo' | 'recognition' | 'citation', provider: 'claude' | 'gpt' | null, label: string }> = [
      { cat: 'seo', provider: null, label: 'title' },
      { cat: 'recognition', provider: 'claude', label: 'prompt_1' },
      { cat: 'citation', provider: 'gpt', label: 'official-url' },
    ]
    for (const { cat, provider, label } of sequences) {
      s = reduceGradeEvents(s, { type: 'probe.started', category: cat, provider, label }, NOW + 200)
      s = reduceGradeEvents(s, {
        type: 'probe.completed', category: cat, provider, label, score: 80, durationMs: 500, error: null,
      }, NOW + 700)
    }
    s = reduceGradeEvents(s, {
      type: 'done', overall: 80, letter: 'B-',
      scores: { discoverability: 80, recognition: 80, accuracy: 80, coverage: 80, citation: 80, seo: 80 },
    }, NOW + 1000)
    expect(s.phase).toBe('done')
    expect(s.probes.size).toBe(3)
    expect([...s.probes.values()].every((p) => p.status === 'completed')).toBe(true)
  })
})
