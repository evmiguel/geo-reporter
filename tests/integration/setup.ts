import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import * as schema from '../../src/db/schema.ts'
import type { Db } from '../../src/db/client.ts'

export interface TestDb {
  container: StartedPostgreSqlContainer
  db: Db
  url: string
  stop: () => Promise<void>
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = container.getConnectionUri()
  const client = postgres(url, { prepare: false, max: 2 })
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: './src/db/migrations' })
  return {
    container,
    db,
    url,
    stop: async () => {
      await client.end({ timeout: 5 })
      await container.stop()
    },
  }
}
