import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config/env.ts'
import * as schema from './schema.ts'

export type Db = PostgresJsDatabase<typeof schema>

export const sql = postgres(env.DATABASE_URL, { prepare: false, max: 10 })
export const db: Db = drizzle(sql, { schema })

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 })
}
