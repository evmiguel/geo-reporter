import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderReport } from '../../../src/report/render.tsx'
import { buildReportInput } from '../../../src/report/build-input.ts'
import { makeReportRecord } from '../../fixtures/report.ts'

describe('renderReport', () => {
  beforeEach(() => {
    // Freeze the clock so `buildReportInput`'s `new Date()` stays deterministic for snapshots.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-19T14:32:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits a full HTML document with DOCTYPE and inlined CSS', () => {
    const input = buildReportInput(makeReportRecord())
    const html = renderReport(input, { pdfUrl: '/report/x.pdf?t=tok' })
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).toContain('stripe.com')
    expect(html).toContain('Methodology')
    expect(html).toContain('Download PDF')
  })

  it('snapshots a full render', () => {
    const input = buildReportInput(makeReportRecord())
    const html = renderReport(input, { pdfUrl: '/report/x.pdf?t=tok' })
    expect(html).toMatchSnapshot()
  })
})
