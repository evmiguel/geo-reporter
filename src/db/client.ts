import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config/env.ts'
import * as schema from './schema.ts'

const sql = postgres(env.DATABASE_URL, { prepare: false, max: 10 })
export const db = drizzle(sql, { schema })
export type Db = typeof db
