import { describe, it, expect } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import * as schema from '../../../src/db/schema.ts'

describe('stripe_payments.user_id nullability', () => {
  it('is nullable (required for account deletion anonymization)', () => {
    const cols = getTableColumns(schema.stripePayments)
    expect((cols.userId as { notNull: boolean }).notNull).toBe(false)
  })
})
