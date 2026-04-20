import { describe, it, expect } from 'vitest'
import { pdfQueueName, type PdfJob } from '../../../src/queue/queues.ts'

describe('pdfQueue shape', () => {
  it('job shape is { reportId }', () => {
    const job: PdfJob = { reportId: 'abc' }
    expect(job.reportId).toBe('abc')
  })
  it('queue name is stable', () => {
    expect(pdfQueueName).toBe('pdf')
  })
})
