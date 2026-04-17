# GEO Reporter — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `v3/` project skeleton — pnpm workspace, TypeScript, Drizzle + Postgres, Redis + BullMQ, Hono web service with a working `/healthz`, worker entrypoint, and CI — so every subsequent plan has somewhere to write code.

**Architecture:** Two Node processes built from one repo. `server.ts` runs Hono; `worker.ts` runs BullMQ. They share `db/`, `queue/`, `store/`, and will later share `core/`, `scraper/`, `seo/`. Local dev uses docker-compose for Postgres + Redis.

**Tech Stack:** Node 20, TypeScript 5.4, Hono 4, Drizzle ORM + postgres-js, BullMQ 5, ioredis, vitest 2, testcontainers 10, tsup, pnpm 9, GitHub Actions.

---

## File Structure

Files created by this plan:

```
v3/
├── package.json                       task 1
├── pnpm-workspace.yaml                (not needed yet; plan B decided v3/ is standalone, leave out)
├── tsconfig.json                      task 2
├── tsup.config.ts                     task 13
├── drizzle.config.ts                  task 4
├── vitest.config.ts                   task 11
├── docker-compose.yml                 task 3
├── .env.example                       task 3
├── .gitignore                         task 1
├── src/
│   ├── config/
│   │   └── env.ts                     task 3
│   ├── db/
│   │   ├── schema.ts                  task 4
│   │   ├── client.ts                  task 4
│   │   └── migrations/                task 4 (auto-generated)
│   ├── store/
│   │   ├── types.ts                   task 5
│   │   └── postgres.ts                task 6
│   ├── queue/
│   │   ├── redis.ts                   task 7
│   │   ├── queues.ts                  task 8
│   │   └── workers/
│   │       └── health.ts              task 9
│   ├── server/
│   │   ├── app.ts                     task 10
│   │   └── server.ts                  task 10
│   ├── worker/
│   │   └── worker.ts                  task 9
│   └── index.ts                       task 13 (re-exports)
├── tests/
│   ├── unit/
│   │   └── db/schema.test.ts          task 11
│   └── integration/
│       ├── setup.ts                   task 12
│       └── healthz.test.ts            task 12
└── .github/workflows/ci.yml           task 14
```

---

## Task 1: Initialize pnpm project

**Files:**
- Create: `v3/package.json`
- Create: `v3/.gitignore`

- [ ] **Step 1: Create `v3/package.json`**

```json
{
  "name": "geo-reporter",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.11" },
  "packageManager": "pnpm@9.6.0",
  "scripts": {
    "build": "tsup",
    "dev:server": "tsx watch src/server/server.ts",
    "dev:worker": "tsx watch src/worker/worker.ts",
    "start:server": "node dist/server.js",
    "start:worker": "node dist/worker.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "bullmq": "^5.12.0",
    "drizzle-orm": "^0.33.0",
    "hono": "^4.5.0",
    "ioredis": "^5.4.0",
    "postgres": "^3.4.4",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "drizzle-kit": "^0.24.0",
    "testcontainers": "^10.13.0",
    "@testcontainers/postgresql": "^10.13.0",
    "tsup": "^8.3.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `v3/.gitignore`**

```
node_modules/
dist/
coverage/
.env
.env.local
*.tsbuildinfo
tmp/
```

- [ ] **Step 3: Install dependencies**

Run (from `v3/`): `pnpm install`
Expected: `Done in <N>s` without errors; `v3/pnpm-lock.yaml` appears.

- [ ] **Step 4: Commit**

```bash
git add v3/package.json v3/.gitignore v3/pnpm-lock.yaml
git commit -m "feat(v3): initialize pnpm project with core deps"
```

---

## Task 2: TypeScript configuration

**Files:**
- Create: `v3/tsconfig.json`

- [ ] **Step 1: Create `v3/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "types": ["node"],
    "rootDir": ".",
    "baseUrl": "."
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Verify typecheck passes on empty src**

Run: `mkdir -p v3/src && echo "export {}" > v3/src/index.ts && cd v3 && pnpm typecheck`
Expected: exits 0 silently.

Note on the config: `allowImportingTsExtensions: true` + `noEmit: true` means TypeScript only type-checks — it does not emit `.js`. Runtime uses tsx (dev) and tsup (prod) to execute/bundle the `.ts` sources directly. This is why code in later tasks imports with explicit `.ts` extensions (e.g. `import { env } from '../config/env.ts'`).

- [ ] **Step 3: Commit**

```bash
git add v3/tsconfig.json v3/src/index.ts
git commit -m "feat(v3): add TypeScript config"
```

---

## Task 3: Local dev compose + env loader

**Files:**
- Create: `v3/docker-compose.yml`
- Create: `v3/.env.example`
- Create: `v3/src/config/env.ts`
- Create: `v3/tests/unit/config/env.test.ts`

- [ ] **Step 1: Create `v3/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: geo
      POSTGRES_PASSWORD: geo
      POSTGRES_DB: geo
    ports:
      - "54320:5432"
    volumes:
      - geo-pg:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "63790:6379"

volumes:
  geo-pg:
```

- [ ] **Step 2: Create `v3/.env.example`**

```
DATABASE_URL=postgres://geo:geo@127.0.0.1:54320/geo
REDIS_URL=redis://127.0.0.1:63790
NODE_ENV=development
PORT=7777
```

- [ ] **Step 3: Write failing test `v3/tests/unit/config/env.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../../src/config/env.ts'

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://u:p@h:1/d',
      REDIS_URL: 'redis://h:1',
      NODE_ENV: 'test',
      PORT: '8080',
    })
    expect(env.PORT).toBe(8080)
    expect(env.NODE_ENV).toBe('test')
  })

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadEnv({ REDIS_URL: 'redis://h:1' })).toThrow(/DATABASE_URL/)
  })

  it('defaults PORT to 7777', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://u:p@h:1/d',
      REDIS_URL: 'redis://h:1',
    })
    expect(env.PORT).toBe(7777)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd v3 && pnpm test -- env.test`
Expected: FAIL — `loadEnv` not defined / module not found.

- [ ] **Step 5: Implement `v3/src/config/env.ts`**

```ts
import { z } from 'zod'

const Schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7777),
})

export type Env = z.infer<typeof Schema>

export function loadEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  const result = Schema.safeParse(raw)
  if (!result.success) {
    const missing = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
    throw new Error(`Invalid environment: ${missing}`)
  }
  return result.data
}

export const env = loadEnv()
```

Note: leave the top-level `export const env = loadEnv()` for runtime use; tests import `loadEnv` directly and inject fake envs, so the top-level parse only runs when the module is imported at runtime startup.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd v3 && pnpm test -- env.test`
Expected: 3 passing.

- [ ] **Step 7: Commit**

```bash
git add v3/docker-compose.yml v3/.env.example v3/src/config/env.ts v3/tests/unit/config/env.test.ts
git commit -m "feat(v3): add docker-compose, env loader with zod validation"
```

---

## Task 4: Drizzle schema + client

**Files:**
- Create: `v3/drizzle.config.ts`
- Create: `v3/src/db/schema.ts`
- Create: `v3/src/db/client.ts`
- Create: `v3/tests/unit/db/schema.test.ts`

Schema covers every table in spec §9. Migrations live in `src/db/migrations/` and will be checked into git.

- [ ] **Step 1: Create `v3/drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://geo:geo@127.0.0.1:54320/geo',
  },
  verbose: true,
  strict: true,
})
```

- [ ] **Step 2: Write failing test `v3/tests/unit/db/schema.test.ts`**

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd v3 && pnpm test -- schema.test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `v3/src/db/schema.ts`**

```ts
import { sql } from 'drizzle-orm'
import { pgTable, text, uuid, integer, boolean, jsonb, timestamp, unique } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const cookies = pgTable('cookies', {
  cookie: text('cookie').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const grades = pgTable('grades', {
  id: uuid('id').primaryKey().defaultRandom(),
  url: text('url').notNull(),
  domain: text('domain').notNull(),
  tier: text('tier', { enum: ['free', 'paid'] }).notNull(),
  cookie: text('cookie').references(() => cookies.cookie, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull().default('queued'),
  overall: integer('overall'),
  letter: text('letter'),
  scores: jsonb('scores'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const scrapes = pgTable('scrapes', {
  id: uuid('id').primaryKey().defaultRandom(),
  gradeId: uuid('grade_id').notNull().references(() => grades.id, { onDelete: 'cascade' }).unique(),
  rendered: boolean('rendered').notNull().default(false),
  html: text('html').notNull(),
  text: text('text').notNull(),
  structured: jsonb('structured').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
})

export const probes = pgTable('probes', {
  id: uuid('id').primaryKey().defaultRandom(),
  gradeId: uuid('grade_id').notNull().references(() => grades.id, { onDelete: 'cascade' }),
  category: text('category', {
    enum: ['discoverability', 'recognition', 'coverage', 'accuracy', 'citation', 'seo'],
  }).notNull(),
  provider: text('provider'),
  prompt: text('prompt').notNull(),
  response: text('response').notNull(),
  score: integer('score'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const recommendations = pgTable('recommendations', {
  id: uuid('id').primaryKey().defaultRandom(),
  gradeId: uuid('grade_id').notNull().references(() => grades.id, { onDelete: 'cascade' }),
  rank: integer('rank').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  impact: integer('impact').notNull(),
  effort: integer('effort').notNull(),
  rationale: text('rationale').notNull(),
  how: text('how').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  gradeId: uuid('grade_id').notNull().references(() => grades.id, { onDelete: 'cascade' }).unique(),
  token: text('token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const stripePayments = pgTable('stripe_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  gradeId: uuid('grade_id').notNull().references(() => grades.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().unique(),
  status: text('status', { enum: ['pending', 'paid', 'refunded', 'failed'] }).notNull().default('pending'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const magicTokens = pgTable('magic_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  cookie: text('cookie').references(() => cookies.cookie, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqByHash: unique('magic_tokens_hash_unique').on(t.tokenHash),
}))
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd v3 && pnpm test -- schema.test`
Expected: 2 passing.

- [ ] **Step 6: Generate the first migration**

Prereq: `docker compose up -d postgres` (schema generation doesn't need DB, but `db:migrate` below does).

Run: `cd v3 && DATABASE_URL=postgres://geo:geo@127.0.0.1:54320/geo pnpm db:generate`
Expected: file created at `v3/src/db/migrations/0000_<random>.sql` containing `CREATE TABLE` statements for all 9 tables.

- [ ] **Step 7: Apply the migration to the running local DB**

Run: `cd v3 && DATABASE_URL=postgres://geo:geo@127.0.0.1:54320/geo pnpm db:migrate`
Expected: migration applied; `psql $DATABASE_URL -c '\dt'` (or equivalent) lists all 9 tables.

- [ ] **Step 8: Implement `v3/src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config/env.ts'
import * as schema from './schema.ts'

const sql = postgres(env.DATABASE_URL, { prepare: false, max: 10 })
export const db = drizzle(sql, { schema })
export type Db = typeof db
```

- [ ] **Step 9: Commit**

```bash
git add v3/drizzle.config.ts v3/src/db/ v3/tests/unit/db/
git commit -m "feat(v3): add drizzle schema, client, initial migration"
```

---

## Task 5: Store interface

**Files:**
- Create: `v3/src/store/types.ts`

Defines the repository shape. Implementations land in Task 6 and later plans.

- [ ] **Step 1: Create `v3/src/store/types.ts`**

```ts
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type * as schema from '../db/schema.ts'

export type Grade = InferSelectModel<typeof schema.grades>
export type NewGrade = InferInsertModel<typeof schema.grades>
export type Probe = InferSelectModel<typeof schema.probes>
export type NewProbe = InferInsertModel<typeof schema.probes>
export type Scrape = InferSelectModel<typeof schema.scrapes>
export type NewScrape = InferInsertModel<typeof schema.scrapes>
export type User = InferSelectModel<typeof schema.users>
export type Cookie = InferSelectModel<typeof schema.cookies>
export type Recommendation = InferSelectModel<typeof schema.recommendations>
export type NewRecommendation = InferInsertModel<typeof schema.recommendations>
export type Report = InferSelectModel<typeof schema.reports>
export type NewReport = InferInsertModel<typeof schema.reports>
export type StripePayment = InferSelectModel<typeof schema.stripePayments>
export type MagicToken = InferSelectModel<typeof schema.magicTokens>

export interface GradeStore {
  // Grades
  createGrade(input: NewGrade): Promise<Grade>
  getGrade(id: string): Promise<Grade | null>
  updateGrade(id: string, patch: Partial<Grade>): Promise<void>

  // Probes
  createProbe(input: NewProbe): Promise<Probe>
  listProbes(gradeId: string): Promise<Probe[]>

  // Scrapes
  createScrape(input: NewScrape): Promise<Scrape>
  getScrape(gradeId: string): Promise<Scrape | null>

  // Users / cookies (placeholder; expanded in auth plan)
  upsertUser(email: string): Promise<User>
  upsertCookie(cookie: string, userId?: string): Promise<Cookie>

  // Recommendations (expanded in report plan)
  createRecommendations(rows: NewRecommendation[]): Promise<void>
  listRecommendations(gradeId: string): Promise<Recommendation[]>

  // Reports (expanded in report plan)
  createReport(input: NewReport): Promise<Report>
  getReport(gradeId: string): Promise<Report | null>
}
```

- [ ] **Step 2: Typecheck**

Run: `cd v3 && pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add v3/src/store/types.ts
git commit -m "feat(v3): add GradeStore interface"
```

---

## Task 6: Postgres store implementation (skeleton)

**Files:**
- Create: `v3/src/store/postgres.ts`
- Create: `v3/tests/integration/store.test.ts`
- Create: `v3/tests/integration/setup.ts`

The skeleton implements every method; later plans enrich semantics. Integration test uses testcontainers so no shared DB state.

- [ ] **Step 1: Create test-side Postgres container helper `v3/tests/integration/setup.ts`**

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import * as schema from '../../src/db/schema.ts'

export interface TestDb {
  container: StartedPostgreSqlContainer
  db: ReturnType<typeof drizzle>
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
```

- [ ] **Step 2: Write failing test `v3/tests/integration/store.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

let ctx: TestDb
let store: PostgresStore

beforeAll(async () => {
  ctx = await startTestDb()
  store = new PostgresStore(ctx.db)
}, 60_000)

afterAll(async () => {
  await ctx.stop()
})

describe('PostgresStore', () => {
  it('creates and fetches a grade', async () => {
    const created = await store.createGrade({
      url: 'https://example.com',
      domain: 'example.com',
      tier: 'free',
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i)
    const fetched = await store.getGrade(created.id)
    expect(fetched?.url).toBe('https://example.com')
    expect(fetched?.status).toBe('queued')
  })

  it('updateGrade patches status and scores', async () => {
    const g = await store.createGrade({ url: 'https://x.com', domain: 'x.com', tier: 'free' })
    await store.updateGrade(g.id, { status: 'done', overall: 72, letter: 'B-', scores: { recognition: 80 } })
    const after = await store.getGrade(g.id)
    expect(after?.status).toBe('done')
    expect(after?.overall).toBe(72)
  })

  it('createProbe + listProbes round-trips', async () => {
    const g = await store.createGrade({ url: 'https://y.com', domain: 'y.com', tier: 'free' })
    await store.createProbe({
      gradeId: g.id,
      category: 'recognition',
      provider: 'claude',
      prompt: 'p',
      response: 'r',
      score: 55,
    })
    const probes = await store.listProbes(g.id)
    expect(probes).toHaveLength(1)
    expect(probes[0]?.category).toBe('recognition')
  })

  it('createScrape + getScrape round-trips', async () => {
    const g = await store.createGrade({ url: 'https://z.com', domain: 'z.com', tier: 'free' })
    await store.createScrape({
      gradeId: g.id,
      rendered: false,
      html: '<html>',
      text: 'hi',
      structured: { og: {} },
    })
    const s = await store.getScrape(g.id)
    expect(s?.text).toBe('hi')
  })

  it('upsertUser is idempotent', async () => {
    const a = await store.upsertUser('a@b.com')
    const b = await store.upsertUser('a@b.com')
    expect(a.id).toBe(b.id)
  })

  it('createReport + getReport round-trips', async () => {
    const g = await store.createGrade({ url: 'https://q.com', domain: 'q.com', tier: 'paid' })
    await store.createReport({ gradeId: g.id, token: 'abc' })
    const r = await store.getReport(g.id)
    expect(r?.token).toBe('abc')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd v3 && pnpm test:integration -- store.test`
Expected: FAIL — `PostgresStore` not found.

- [ ] **Step 4: Implement `v3/src/store/postgres.ts`**

```ts
import { eq, desc } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import * as schema from '../db/schema.ts'
import type {
  GradeStore,
  Grade,
  NewGrade,
  Probe,
  NewProbe,
  Scrape,
  NewScrape,
  User,
  Cookie,
  Recommendation,
  NewRecommendation,
  Report,
  NewReport,
} from './types.ts'

export class PostgresStore implements GradeStore {
  constructor(private readonly db: Db) {}

  async createGrade(input: NewGrade): Promise<Grade> {
    const [row] = await this.db.insert(schema.grades).values(input).returning()
    if (!row) throw new Error('createGrade returned no row')
    return row
  }

  async getGrade(id: string): Promise<Grade | null> {
    const [row] = await this.db.select().from(schema.grades).where(eq(schema.grades.id, id)).limit(1)
    return row ?? null
  }

  async updateGrade(id: string, patch: Partial<Grade>): Promise<void> {
    const { id: _omit, ...rest } = patch
    await this.db.update(schema.grades).set({ ...rest, updatedAt: new Date() }).where(eq(schema.grades.id, id))
  }

  async createProbe(input: NewProbe): Promise<Probe> {
    const [row] = await this.db.insert(schema.probes).values(input).returning()
    if (!row) throw new Error('createProbe returned no row')
    return row
  }

  async listProbes(gradeId: string): Promise<Probe[]> {
    return this.db.select().from(schema.probes).where(eq(schema.probes.gradeId, gradeId)).orderBy(desc(schema.probes.createdAt))
  }

  async createScrape(input: NewScrape): Promise<Scrape> {
    const [row] = await this.db.insert(schema.scrapes).values(input).returning()
    if (!row) throw new Error('createScrape returned no row')
    return row
  }

  async getScrape(gradeId: string): Promise<Scrape | null> {
    const [row] = await this.db.select().from(schema.scrapes).where(eq(schema.scrapes.gradeId, gradeId)).limit(1)
    return row ?? null
  }

  async upsertUser(email: string): Promise<User> {
    const [row] = await this.db
      .insert(schema.users)
      .values({ email })
      .onConflictDoUpdate({ target: schema.users.email, set: { email } })
      .returning()
    if (!row) throw new Error('upsertUser returned no row')
    return row
  }

  async upsertCookie(cookie: string, userId?: string): Promise<Cookie> {
    const [row] = await this.db
      .insert(schema.cookies)
      .values({ cookie, userId: userId ?? null })
      .onConflictDoUpdate({ target: schema.cookies.cookie, set: { userId: userId ?? null } })
      .returning()
    if (!row) throw new Error('upsertCookie returned no row')
    return row
  }

  async createRecommendations(rows: NewRecommendation[]): Promise<void> {
    if (rows.length === 0) return
    await this.db.insert(schema.recommendations).values(rows)
  }

  async listRecommendations(gradeId: string): Promise<Recommendation[]> {
    return this.db
      .select()
      .from(schema.recommendations)
      .where(eq(schema.recommendations.gradeId, gradeId))
      .orderBy(schema.recommendations.rank)
  }

  async createReport(input: NewReport): Promise<Report> {
    const [row] = await this.db.insert(schema.reports).values(input).returning()
    if (!row) throw new Error('createReport returned no row')
    return row
  }

  async getReport(gradeId: string): Promise<Report | null> {
    const [row] = await this.db.select().from(schema.reports).where(eq(schema.reports.gradeId, gradeId)).limit(1)
    return row ?? null
  }
}
```

- [ ] **Step 5: Add integration vitest config `v3/vitest.integration.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
})
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd v3 && pnpm test:integration -- store.test`
Expected: 6 passing.

- [ ] **Step 7: Commit**

```bash
git add v3/src/store/postgres.ts v3/tests/integration/setup.ts v3/tests/integration/store.test.ts v3/vitest.integration.config.ts
git commit -m "feat(v3): add PostgresStore skeleton + integration tests"
```

---

## Task 7: Redis client helper

**Files:**
- Create: `v3/src/queue/redis.ts`
- Create: `v3/tests/integration/redis.test.ts`

- [ ] **Step 1: Write failing test `v3/tests/integration/redis.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { createRedis } from '../../src/queue/redis.ts'
import type Redis from 'ioredis'

let container: StartedTestContainer
let redis: Redis

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
  redis = createRedis(url)
}, 60_000)

afterAll(async () => {
  await redis.quit()
  await container.stop()
})

describe('createRedis', () => {
  it('connects and PING returns PONG', async () => {
    const reply = await redis.ping()
    expect(reply).toBe('PONG')
  })

  it('can set and get a key', async () => {
    await redis.set('foo', 'bar')
    expect(await redis.get('foo')).toBe('bar')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v3 && pnpm test:integration -- redis.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `v3/src/queue/redis.ts`**

```ts
import Redis from 'ioredis'

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null, // required by BullMQ workers
    enableReadyCheck: true,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd v3 && pnpm test:integration -- redis.test`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add v3/src/queue/redis.ts v3/tests/integration/redis.test.ts
git commit -m "feat(v3): add redis client helper"
```

---

## Task 8: BullMQ producer + queue definitions

**Files:**
- Create: `v3/src/queue/queues.ts`
- Create: `v3/tests/integration/queues.test.ts`

Declares the three queues (`grade`, `report`, `pdf`) and a small producer wrapper. Job data shapes are defined here so producer and worker share one source of truth.

- [ ] **Step 1: Write failing test `v3/tests/integration/queues.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Worker } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { enqueueGrade, gradeQueueName } from '../../src/queue/queues.ts'

let container: StartedTestContainer
let redisUrl: string

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('enqueueGrade', () => {
  it('enqueues a job that a worker picks up', async () => {
    const producerRedis = createRedis(redisUrl)
    const consumerRedis = createRedis(redisUrl)

    const received: string[] = []
    const worker = new Worker(
      gradeQueueName,
      async (job) => {
        received.push(job.data.gradeId)
      },
      { connection: consumerRedis },
    )

    await enqueueGrade({ gradeId: 'grade-1', tier: 'free' }, producerRedis)

    await new Promise<void>((resolve) => {
      worker.on('completed', () => resolve())
    })

    expect(received).toEqual(['grade-1'])

    await worker.close()
    await producerRedis.quit()
    await consumerRedis.quit()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v3 && pnpm test:integration -- queues.test`
Expected: FAIL — `enqueueGrade` not defined.

- [ ] **Step 3: Implement `v3/src/queue/queues.ts`**

```ts
import { Queue } from 'bullmq'
import type Redis from 'ioredis'

export const gradeQueueName = 'grade' as const
export const reportQueueName = 'report' as const
export const pdfQueueName = 'pdf' as const

export interface GradeJob {
  gradeId: string
  tier: 'free' | 'paid'
}
export interface ReportJob {
  gradeId: string
}
export interface PdfJob {
  gradeId: string
  token: string
}

let gradeQueue: Queue<GradeJob> | undefined
let reportQueue: Queue<ReportJob> | undefined
let pdfQueue: Queue<PdfJob> | undefined

export function getGradeQueue(connection: Redis): Queue<GradeJob> {
  gradeQueue ??= new Queue<GradeJob>(gradeQueueName, { connection })
  return gradeQueue
}
export function getReportQueue(connection: Redis): Queue<ReportJob> {
  reportQueue ??= new Queue<ReportJob>(reportQueueName, { connection })
  return reportQueue
}
export function getPdfQueue(connection: Redis): Queue<PdfJob> {
  pdfQueue ??= new Queue<PdfJob>(pdfQueueName, { connection })
  return pdfQueue
}

export async function enqueueGrade(job: GradeJob, connection: Redis): Promise<void> {
  await getGradeQueue(connection).add('run-grade', job, {
    removeOnComplete: { age: 3600 }, // 1h
    removeOnFail: { age: 24 * 3600 }, // 1d
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  })
}

export async function enqueueReport(job: ReportJob, connection: Redis): Promise<void> {
  await getReportQueue(connection).add('generate-report', job, { attempts: 3 })
}

import { QueueEvents } from 'bullmq'

let pdfQueueEvents: QueueEvents | undefined
function getPdfQueueEvents(connection: Redis): QueueEvents {
  pdfQueueEvents ??= new QueueEvents(pdfQueueName, { connection })
  return pdfQueueEvents
}

export async function enqueuePdf(job: PdfJob, connection: Redis): Promise<Buffer> {
  const queued = await getPdfQueue(connection).add('render-pdf', job, { attempts: 2 })
  const result = await queued.waitUntilFinished(getPdfQueueEvents(connection), 30_000)
  if (!(result instanceof Buffer)) throw new Error('PDF job did not return a Buffer')
  return result
}
```

Note: `enqueuePdf` is a library helper reused from Plan 9 (report rendering). Plan 1 doesn't exercise it at runtime — only the export surface and types must compile cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd v3 && pnpm test:integration -- queues.test`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add v3/src/queue/queues.ts v3/tests/integration/queues.test.ts
git commit -m "feat(v3): add BullMQ queues + enqueue helpers"
```

---

## Task 9: Worker entrypoint with a dummy health job

**Files:**
- Create: `v3/src/queue/workers/health.ts`
- Create: `v3/src/worker/worker.ts`
- Create: `v3/tests/integration/worker.test.ts`

Produces a real worker binary we can boot in CI. Real `run-grade` / `generate-report` workers land in later plans; here we register a `health-ping` worker that just ACKs.

- [ ] **Step 1: Implement `v3/src/queue/workers/health.ts`**

```ts
import { Worker } from 'bullmq'
import type Redis from 'ioredis'

export const healthQueueName = 'health' as const

export function registerHealthWorker(connection: Redis): Worker {
  return new Worker(
    healthQueueName,
    async () => ({ ok: true, at: Date.now() }),
    { connection },
  )
}
```

- [ ] **Step 2: Write failing test `v3/tests/integration/worker.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Queue, QueueEvents } from 'bullmq'
import { createRedis } from '../../src/queue/redis.ts'
import { registerHealthWorker, healthQueueName } from '../../src/queue/workers/health.ts'

let container: StartedTestContainer
let redisUrl: string

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('health worker', () => {
  it('acks a health-ping job', async () => {
    const connection = createRedis(redisUrl)
    const worker = registerHealthWorker(connection)
    const queue = new Queue(healthQueueName, { connection })
    const events = new QueueEvents(healthQueueName, { connection: createRedis(redisUrl) })

    const job = await queue.add('ping', {})
    const result = await job.waitUntilFinished(events, 10_000)
    expect(result.ok).toBe(true)

    await worker.close()
    await queue.close()
    await events.close()
    await connection.quit()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd v3 && pnpm test:integration -- worker.test`
Expected: FAIL — `registerHealthWorker` missing.

- [ ] **Step 4: Implement `v3/src/worker/worker.ts` (real entrypoint)**

```ts
import { env } from '../config/env.ts'
import { createRedis } from '../queue/redis.ts'
import { registerHealthWorker } from '../queue/workers/health.ts'

const connection = createRedis(env.REDIS_URL)
const workers = [registerHealthWorker(connection)]

console.log(JSON.stringify({ msg: 'worker started', workers: workers.length }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'worker shutting down', signal }))
  await Promise.all(workers.map((w) => w.close()))
  await connection.quit()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd v3 && pnpm test:integration -- worker.test`
Expected: 1 passing.

- [ ] **Step 6: Smoke-boot the worker locally (optional)**

Prereq: `docker compose up -d redis postgres`. Run: `cd v3 && pnpm dev:worker` → expect a single JSON log line `{"msg":"worker started","workers":1}`. Ctrl-C cleanly.

- [ ] **Step 7: Commit**

```bash
git add v3/src/queue/workers/health.ts v3/src/worker/worker.ts v3/tests/integration/worker.test.ts
git commit -m "feat(v3): add worker entrypoint with health ping worker"
```

---

## Task 10: Hono web server with `/healthz`

**Files:**
- Create: `v3/src/server/app.ts`
- Create: `v3/src/server/server.ts`
- Create: `v3/tests/unit/server/healthz.test.ts`
- Create: `v3/tests/integration/healthz.test.ts`

`/healthz` returns `{ ok: true }` only when both the DB and Redis answer.

- [ ] **Step 1: Write failing unit test `v3/tests/unit/server/healthz.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../../src/server/app.ts'

const okDeps = {
  pingDb: async () => true,
  pingRedis: async () => true,
}

describe('/healthz (unit)', () => {
  it('returns ok when both deps are healthy', async () => {
    const app = buildApp(okDeps)
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: true, redis: true })
  })

  it('returns 503 when db fails', async () => {
    const app = buildApp({ ...okDeps, pingDb: async () => false })
    const res = await app.request('/healthz')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.db).toBe(false)
  })

  it('returns 503 when redis throws', async () => {
    const app = buildApp({ ...okDeps, pingRedis: async () => { throw new Error('boom') } })
    const res = await app.request('/healthz')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.redis).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd v3 && pnpm test -- healthz.test`
Expected: FAIL — `buildApp` not found.

- [ ] **Step 3: Implement `v3/src/server/app.ts`**

```ts
import { Hono } from 'hono'

export interface AppDeps {
  pingDb: () => Promise<boolean>
  pingRedis: () => Promise<boolean>
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono()

  app.get('/healthz', async (c) => {
    const [dbResult, redisResult] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()])
    const db = dbResult.status === 'fulfilled' && dbResult.value === true
    const redis = redisResult.status === 'fulfilled' && redisResult.value === true
    const ok = db && redis
    return c.json({ ok, db, redis }, ok ? 200 : 503)
  })

  return app
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `cd v3 && pnpm test -- healthz.test`
Expected: 3 passing.

- [ ] **Step 5: Implement `v3/src/server/server.ts`**

```ts
import { serve } from '@hono/node-server'
import { sql } from 'drizzle-orm'
import { env } from '../config/env.ts'
import { db } from '../db/client.ts'
import { createRedis } from '../queue/redis.ts'
import { buildApp } from './app.ts'

const redis = createRedis(env.REDIS_URL)

const app = buildApp({
  pingDb: async () => {
    try {
      await db.execute(sql`select 1`)
      return true
    } catch { return false }
  },
  pingRedis: async () => (await redis.ping()) === 'PONG',
})

const server = serve({ fetch: app.fetch, port: env.PORT })
console.log(JSON.stringify({ msg: 'server listening', port: env.PORT }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'server shutting down', signal }))
  server.close()
  await redis.quit()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

- [ ] **Step 6: Install `@hono/node-server`**

Run: `cd v3 && pnpm add @hono/node-server`
Expected: added to dependencies.

- [ ] **Step 7: Write failing integration test `v3/tests/integration/healthz.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { buildApp } from '../../src/server/app.ts'
import { createRedis } from '../../src/queue/redis.ts'

let pg: StartedPostgreSqlContainer
let redisContainer: StartedTestContainer
let stop: () => Promise<void>

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start()
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  const pgClient = postgres(pg.getConnectionUri(), { prepare: false, max: 2 })
  const db = drizzle(pgClient)
  await migrate(db, { migrationsFolder: './src/db/migrations' })
  const redis = createRedis(`redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`)

  stop = async () => {
    await pgClient.end({ timeout: 5 })
    await redis.quit()
    await pg.stop()
    await redisContainer.stop()
  }

  ;(globalThis as any).__app = buildApp({
    pingDb: async () => {
      try { await db.execute(sql`select 1`); return true } catch { return false }
    },
    pingRedis: async () => (await redis.ping()) === 'PONG',
  })
}, 60_000)

afterAll(async () => {
  await stop()
})

describe('/healthz (integration)', () => {
  it('returns ok against real postgres + redis', async () => {
    const res = await (globalThis as any).__app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: true, redis: true })
  })
})
```

- [ ] **Step 8: Run integration test to verify it passes**

Run: `cd v3 && pnpm test:integration -- healthz.test`
Expected: 1 passing.

- [ ] **Step 9: Commit**

```bash
git add v3/src/server/ v3/tests/unit/server/healthz.test.ts v3/tests/integration/healthz.test.ts v3/package.json v3/pnpm-lock.yaml
git commit -m "feat(v3): add hono server with /healthz"
```

---

## Task 11: Unit vitest config

**Files:**
- Create: `v3/vitest.config.ts`

Keeps unit tests separate from integration (integration has its own config from Task 6).

- [ ] **Step 1: Create `v3/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    testTimeout: 5_000,
  },
})
```

- [ ] **Step 2: Run unit tests to confirm config is picked up**

Run: `cd v3 && pnpm test`
Expected: all unit tests pass (env, schema, healthz unit), integration tests are NOT run.

- [ ] **Step 3: Commit**

```bash
git add v3/vitest.config.ts
git commit -m "feat(v3): add unit vitest config"
```

---

## Task 12: Build pipeline with tsup

**Files:**
- Create: `v3/tsup.config.ts`

Two entry points → two CJS/ESM bundles in `dist/`.

- [ ] **Step 1: Create `v3/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    server: 'src/server/server.ts',
    worker: 'src/worker/worker.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  minify: false,
})
```

- [ ] **Step 2: Build**

Run: `cd v3 && pnpm build`
Expected: `dist/server.js` and `dist/worker.js` exist; no errors.

- [ ] **Step 3: Boot the built server against local compose**

Prereq: `docker compose up -d`. Run: `cd v3 && DATABASE_URL=postgres://geo:geo@127.0.0.1:54320/geo REDIS_URL=redis://127.0.0.1:63790 node dist/server.js` → in another shell `curl localhost:7777/healthz` → expect `{"ok":true,"db":true,"redis":true}`. Ctrl-C the server.

- [ ] **Step 4: Boot the built worker**

Run: `cd v3 && REDIS_URL=redis://127.0.0.1:63790 DATABASE_URL=postgres://geo:geo@127.0.0.1:54320/geo node dist/worker.js` → expect the `worker started` log, Ctrl-C cleanly.

- [ ] **Step 5: Commit**

```bash
git add v3/tsup.config.ts
git commit -m "feat(v3): add tsup build config for server + worker bundles"
```

---

## Task 13: `src/index.ts` public surface

**Files:**
- Modify: `v3/src/index.ts`

Re-exports the surface that downstream plans will import. Keeps later plans from reaching into internal paths.

- [ ] **Step 1: Replace `v3/src/index.ts`**

```ts
export { env, loadEnv } from './config/env.ts'
export { db, type Db } from './db/client.ts'
export * as schema from './db/schema.ts'
export * from './store/types.ts'
export { PostgresStore } from './store/postgres.ts'
export { createRedis } from './queue/redis.ts'
export {
  enqueueGrade,
  enqueueReport,
  enqueuePdf,
  getGradeQueue,
  getReportQueue,
  getPdfQueue,
  gradeQueueName,
  reportQueueName,
  pdfQueueName,
  type GradeJob,
  type ReportJob,
  type PdfJob,
} from './queue/queues.ts'
```

- [ ] **Step 2: Typecheck**

Run: `cd v3 && pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add v3/src/index.ts
git commit -m "feat(v3): expose package surface via src/index.ts"
```

---

## Task 14: GitHub Actions CI

**Files:**
- Create: `v3/.github/workflows/ci.yml`

Uses repo-root path because workflows live at the repo root in GitHub's convention — but we keep it under `v3/` since v3 is the only project on this branch. (If repo-wide CI already exists at `.github/workflows/`, append a `v3` job there instead; not MVP.)

- [ ] **Step 1: Create `.github/workflows/v3-ci.yml` at the repo root**

File path: `/home/erika/repos/geo-grader/.github/workflows/v3-ci.yml` (i.e. repo-root `.github/workflows/`, NOT under `v3/`).

```yaml
name: v3 CI

on:
  push:
    paths: ['v3/**']
  pull_request:
    paths: ['v3/**']

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: v3
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9.6.0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          cache-dependency-path: v3/pnpm-lock.yaml

      - run: pnpm install --frozen-lockfile

      - run: pnpm typecheck

      - run: pnpm test

      - run: pnpm test:integration
```

Note: testcontainers uses Docker, which is present on `ubuntu-latest` runners by default.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/v3-ci.yml
git commit -m "ci(v3): add v3 test workflow"
```

- [ ] **Step 3: Push branch and observe CI**

Run: `git push origin main` (or open a PR if your flow requires it).
Expected: `v3 CI` workflow completes successfully on GitHub.

---

## Verification — end of plan

After all tasks are complete:

- [ ] **Final typecheck:** `cd v3 && pnpm typecheck` → exits 0
- [ ] **All unit tests pass:** `cd v3 && pnpm test` → all green
- [ ] **All integration tests pass:** `cd v3 && pnpm test:integration` → all green
- [ ] **Build succeeds:** `cd v3 && pnpm build` → `dist/server.js` and `dist/worker.js` present
- [ ] **Local stack boots end-to-end:**
  - `cd v3 && docker compose up -d`
  - `cd v3 && pnpm db:migrate`
  - `cd v3 && pnpm dev:server` and in another shell `pnpm dev:worker`
  - `curl localhost:7777/healthz` → `{"ok":true,"db":true,"redis":true}`
  - Ctrl-C both.
- [ ] **CI green on the branch.**

At this point Plan 2 (Scraper) has a DB, a Redis, a queue topology, a store interface, and a place to add its worker.

---

## What this plan does NOT do (owned by later plans)

- No LLM providers or prompts (Plan 3)
- No scraper module (Plan 2)
- No SEO signals (Plan 4)
- No `POST /grades`, no SSE, no rate limit (Plan 6)
- No auth / magic link (Plan 7)
- No Stripe / paywall / report generation (Plans 8–9)
- No frontend (Plan 6)
- No production deploy (Plan 10)

---

## Execution options

**Plan complete and saved to `v3/docs/superpowers/plans/2026-04-17-geo-reporter-plan-1-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
