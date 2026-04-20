import { sql } from 'drizzle-orm'
import { pgTable, text, uuid, integer, boolean, jsonb, timestamp, unique, index, customType } from 'drizzle-orm/pg-core'

const customBytea = customType<{ data: Buffer; driverData: Buffer; notNull: false; default: false }>({
  dataType() { return 'bytea' },
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  credits: integer('credits').notNull().default(0),
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
}, (t) => ({
  byUser: index('grades_user_id_idx').on(t.userId, t.createdAt.desc()),
  byCookie: index('grades_cookie_idx').on(t.cookie, t.createdAt.desc()),
}))

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
}, (t) => ({
  byGrade: index('probes_grade_id_idx').on(t.gradeId),
}))

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
}, (t) => ({
  byGrade: index('recommendations_grade_id_idx').on(t.gradeId),
}))

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  gradeId: uuid('grade_id').notNull().references(() => grades.id, { onDelete: 'cascade' }).unique(),
  token: text('token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const stripePayments = pgTable('stripe_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  gradeId: uuid('grade_id').references(() => grades.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().unique(),
  kind: text('kind', { enum: ['report', 'credits'] }).notNull().default('report'),
  status: text('status', { enum: ['pending', 'paid', 'refunded', 'failed'] }).notNull().default('pending'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byGrade: index('stripe_payments_grade_id_idx').on(t.gradeId),
}))

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

export const reportPdfs = pgTable('report_pdfs', {
  reportId: uuid('report_id').primaryKey().references(() => reports.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['pending', 'ready', 'failed'] }).notNull().default('pending'),
  bytes: customBytea('bytes'),
  errorMessage: text('error_message'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
