import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { grades, probes, scrapes, users, cookies, recommendations, reports, stripePayments, magicTokens } from '../../../src/db/schema.ts'

describe('schema', () => {
  it('exports every table from the spec', () => {
    for (const t of [grades, probes, scrapes, users, cookies, recommendations, reports, stripePayments, magicTokens]) {
      expect(t).toBeDefined()
    }
  })

  it('grades table has the right columns', () => {
    const cols = Object.keys(getTableColumns(grades))
    for (const c of ['id', 'url', 'domain', 'tier', 'cookie', 'userId', 'status', 'overall', 'letter', 'scores', 'createdAt', 'updatedAt']) {
      expect(cols).toContain(c)
    }
  })
})
