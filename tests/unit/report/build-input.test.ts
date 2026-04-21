import { describe, it, expect } from 'vitest'
import { buildReportInput } from '../../../src/report/build-input.ts'
import { makeReportRecord } from '../../fixtures/report.ts'

describe('buildReportInput', () => {
  const record = makeReportRecord()

  it('exposes grade fields and reportId', () => {
    const input = buildReportInput(record)
    expect(input.grade.domain).toBe('stripe.com')
    expect(input.reportId).toBe(record.report.id)
  })

  it('builds 6 scorecard categories in canonical order', () => {
    const input = buildReportInput(record)
    expect(input.scorecard.map((c) => c.id)).toEqual([
      'discoverability', 'recognition', 'accuracy', 'coverage', 'citation', 'seo',
    ])
    expect(input.scorecard[0]!.weight).toBe(30)
    expect(input.scorecard[0]!.score).toBe(78)
  })

  it('groups raw responses by probe (excluding SEO + accuracy generator rows)', () => {
    const input = buildReportInput(record)
    const categories = input.rawResponsesByProbe.map((g) => g.category)
    expect(categories).not.toContain('seo')
    expect(input.rawResponsesByProbe.every((g) => g.answers.every((a) => a.providerId !== null))).toBe(true)
  })

  it('builds accuracy probes with truth + answer rows', () => {
    const input = buildReportInput(record)
    expect(input.accuracyProbes.length).toBe(1)
    expect(input.accuracyProbes[0]!.question).toBe('What are stripe pricing tiers?')
    expect(input.accuracyProbes[0]!.rows.length).toBeGreaterThan(0)
  })

  it('pairs generator/verify probes when the generator has a real provider stamped (real-world shape)', () => {
    // Reflects what's actually in prod: generator probes run through Claude
    // and carry provider='claude' + metadata.role='generator'. Verify rows
    // cross-reference via metadata.generatorProbeId rather than prompt match.
    // Regression guard for the empty-appendix bug where build-input keyed
    // generators on provider===null.
    const createdAt = new Date('2026-04-21T12:00:00Z')
    const record = makeReportRecord({
      probes: [
        {
          id: 'gen-1', gradeId: 'grade-1', category: 'accuracy',
          provider: 'claude', prompt: '[big scrape context]',
          response: 'What is the starting price of Sunbase pricing plans?',
          score: null,
          metadata: { role: 'generator', model: 'claude-sonnet-4-6' } as never,
          createdAt,
        },
        {
          id: 'v-claude', gradeId: 'grade-1', category: 'accuracy',
          provider: 'claude',
          prompt: 'What is the starting price of Sunbase pricing plans?',
          response: 'I do not have specific pricing information.',
          score: 0,
          metadata: {
            role: 'verify', model: 'claude-sonnet-4-6',
            generatorProbeId: 'gen-1', rationale: 'Scrape says $59/user/month.',
          } as never,
          createdAt,
        },
        {
          id: 'v-gpt', gradeId: 'grade-1', category: 'accuracy',
          provider: 'gpt',
          prompt: 'What is the starting price of Sunbase pricing plans?',
          response: '$5/user/month',
          score: 0,
          metadata: {
            role: 'verify', model: 'gpt-4.1-mini',
            generatorProbeId: 'gen-1', rationale: 'Scrape says $59/user/month.',
          } as never,
          createdAt,
        },
      ],
    })
    const input = buildReportInput(record)
    expect(input.accuracyProbes).toHaveLength(1)
    const probe = input.accuracyProbes[0]!
    expect(probe.question).toBe('What is the starting price of Sunbase pricing plans?')
    expect(probe.rows).toHaveLength(2)
    expect(probe.rows.map((r) => r.providerId).sort()).toEqual(['claude', 'gpt'])
    expect(probe.rows.every((r) => r.ruling === 'wrong')).toBe(true)
    expect(probe.summary).toBe('0 of 2 correct.')
  })

  it('extracts SEO findings from SEO-category probes', () => {
    const input = buildReportInput(record)
    expect(input.seoFindings.map((s) => s.label).sort()).toEqual(['llms_txt', 'robots_txt'])
    const llms = input.seoFindings.find((s) => s.label === 'llms_txt')
    expect(llms?.pass).toBe(false)
  })

  it('sorts recommendations by priority = impact × (6 - effort)', () => {
    const input = buildReportInput(record)
    expect(input.recommendations[0]!.priority).toBeGreaterThanOrEqual(input.recommendations[1]!.priority)
  })

  it('aggregates distinct (provider, model) pairs into models', () => {
    const input = buildReportInput(record)
    const keys = input.models.map((m) => `${m.providerId}:${m.modelId}`).sort()
    expect(keys).toContain('claude:claude-sonnet-4-6')
  })
})
