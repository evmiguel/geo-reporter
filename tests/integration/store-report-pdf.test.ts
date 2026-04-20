import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore report_pdfs methods', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('full lifecycle: init → get → write → get', async () => {
    const grade = await store.createGrade({
      url: 'https://x.test', domain: 'x.test', tier: 'paid', cookie: null, userId: null, status: 'done',
    })
    const report = await store.createReport({ gradeId: grade.id, token: 'tok' })

    await store.initReportPdfRow(report.id)
    const initialRow = await store.getReportPdf(report.id)
    expect(initialRow).toEqual({ status: 'pending', bytes: null })

    await store.initReportPdfRow(report.id)  // idempotent

    const bytes = Buffer.from('fake-pdf-bytes')
    await store.writeReportPdf(report.id, bytes)
    const ready = await store.getReportPdf(report.id)
    expect(ready?.status).toBe('ready')
    expect(ready?.bytes?.equals(bytes)).toBe(true)
  })

  it('getReportPdf returns null when no row exists', async () => {
    const grade = await store.createGrade({
      url: 'https://y.test', domain: 'y.test', tier: 'paid', cookie: null, userId: null, status: 'done',
    })
    const report = await store.createReport({ gradeId: grade.id, token: 'tok3' })
    const row = await store.getReportPdf(report.id)
    expect(row).toBeNull()
  })

  it('setReportPdfStatus failed stores error_message', async () => {
    const grade = await store.createGrade({
      url: 'https://z.test', domain: 'z.test', tier: 'paid', cookie: null, userId: null, status: 'done',
    })
    const report = await store.createReport({ gradeId: grade.id, token: 'tok4' })
    await store.initReportPdfRow(report.id)
    await store.setReportPdfStatus(report.id, 'failed', 'timeout')
    const row = await store.getReportPdf(report.id)
    expect(row?.status).toBe('failed')
    expect(row?.bytes).toBeNull()
  })

  it('ready → failed → recover via writeReportPdf clears errorMessage', async () => {
    const grade = await store.createGrade({
      url: 'https://recover.test', domain: 'recover.test', tier: 'paid', cookie: null, userId: null, status: 'done',
    })
    const report = await store.createReport({ gradeId: grade.id, token: 'tok-recover' })

    await store.initReportPdfRow(report.id)
    await store.writeReportPdf(report.id, Buffer.from('first-bytes'))
    let row = await store.getReportPdf(report.id)
    expect(row?.status).toBe('ready')

    await store.setReportPdfStatus(report.id, 'failed', 'transient error')
    row = await store.getReportPdf(report.id)
    expect(row?.status).toBe('failed')

    // Retry: writeReportPdf flips back to ready and clears errorMessage
    await store.writeReportPdf(report.id, Buffer.from('retry-bytes'))
    row = await store.getReportPdf(report.id)
    expect(row?.status).toBe('ready')
    expect(row?.bytes?.toString()).toBe('retry-bytes')
  })
})
