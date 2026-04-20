import { describe, it, expect } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import * as schema from '../../../src/db/schema.ts'

describe('reportPdfs schema', () => {
  it('exposes a reportPdfs table', () => {
    expect(schema.reportPdfs).toBeDefined()
  })

  it('primary key column is reportId', () => {
    const cols = Object.keys(getTableColumns(schema.reportPdfs))
    expect(cols).toContain('reportId')
    expect(cols).toContain('status')
    expect(cols).toContain('bytes')
    expect(cols).toContain('errorMessage')
    expect(cols).toContain('updatedAt')
  })
})
