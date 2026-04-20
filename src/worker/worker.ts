import { env } from '../config/env.ts'
import { closeDb, db } from '../db/client.ts'
import { createRedis } from '../queue/redis.ts'
import { registerHealthWorker } from '../queue/workers/health.ts'
import { registerRunGradeWorker } from '../queue/workers/run-grade/index.ts'
import { registerGenerateReportWorker } from '../queue/workers/generate-report/index.ts'
import { registerRenderPdfWorker } from '../report/pdf/worker.ts'
import { buildProviders } from '../llm/providers/index.ts'
import { PostgresStore } from '../store/postgres.ts'
import { scrape, shutdownBrowserPool } from '../scraper/index.ts'
import { getBrowserPool } from '../scraper/render.ts'

const connection = createRedis(env.REDIS_URL)
const store = new PostgresStore(db)
const providers = buildProviders({
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  GEMINI_API_KEY: env.GEMINI_API_KEY,
  PERPLEXITY_API_KEY: env.PERPLEXITY_API_KEY,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
})

const workers = [
  registerHealthWorker(connection),
  registerRunGradeWorker({ store, redis: connection, providers, scrapeFn: scrape }, connection),
  registerGenerateReportWorker(
    { store, redis: connection, providers },
    connection,
  ),
  registerRenderPdfWorker({ store, browserPool: getBrowserPool() }, connection),
]

console.log(JSON.stringify({ msg: 'worker started', workers: workers.length }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'worker shutting down', signal }))
  await Promise.all(workers.map((w) => w.close()))
  await connection.quit()
  await closeDb()
  await shutdownBrowserPool()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
