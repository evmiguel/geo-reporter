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
