import { describe, it, expect, vi } from 'vitest'
import { processRenderPdf } from '../../../src/report/pdf/worker.ts'
import { makeReportRecord } from '../../fixtures/report.ts'

describe('processRenderPdf', () => {
  it('happy path: loads record, renders HTML, writes PDF bytes', async () => {
    const writeCalls: Array<{ id: string; bytes: Buffer }> = []
    const withPage = vi.fn(async (fn: (p: unknown) => Promise<Buffer>) => {
      const page = {
        setContent: vi.fn(),
        pdf: vi.fn(async () => Buffer.from('%PDF-fake')),
      } as unknown as Parameters<typeof fn>[0]
      return fn(page)
    })
    const record = makeReportRecord()
    await processRenderPdf({
      store: {
        getReportById: async (id: string) => id === record.report.id ? record : null,
        writeReportPdf: async (id: string, bytes: Buffer) => { writeCalls.push({ id, bytes }) },
        setReportPdfStatus: async () => {},
      } as never,
      browserPool: { withPage } as never,
    }, { reportId: record.report.id })

    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0]!.id).toBe(record.report.id)
    expect(writeCalls[0]!.bytes.toString()).toBe('%PDF-fake')
    expect(withPage).toHaveBeenCalled()
  })

  it('throws if report not found', async () => {
    const deps = {
      store: { getReportById: async () => null, writeReportPdf: async () => {}, setReportPdfStatus: async () => {} } as never,
      browserPool: { withPage: async () => { throw new Error('should not be called') } } as never,
    }
    await expect(processRenderPdf(deps, { reportId: 'nope' })).rejects.toThrow(/not found/)
  })
})
