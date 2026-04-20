import { describe, it, expect } from 'vitest'
import type { GradeJob } from '../../../src/queue/queues.ts'

describe('GradeJob payload', () => {
  it('accepts ip + cookie alongside gradeId + tier', () => {
    const job: GradeJob = {
      gradeId: 'g1', tier: 'free', ip: '127.0.0.1', cookie: 'cookie-1',
    }
    expect(job.ip).toBe('127.0.0.1')
    expect(job.cookie).toBe('cookie-1')
  })
})
