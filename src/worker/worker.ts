import { pathToFileURL } from 'node:url'
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

interface ShutdownDeps {
  workers: Array<{ close: (drain: boolean) => Promise<void> }>
  connection: { quit: () => Promise<'OK' | number> }
  closeDb: () => Promise<void>
  shutdownBrowserPool: () => Promise<void>
}

export function buildShutdown(deps: ShutdownDeps): (signal: NodeJS.Signals, exit?: (code: number) => never) => Promise<void> {
  return async (signal, exit = process.exit as (code: number) => never) => {
    console.log(JSON.stringify({ msg: 'worker shutting down', signal }))
    const timer = setTimeout(() => {
      console.log(JSON.stringify({ msg: 'drain timeout, forcing close' }))
      exit(1)
    }, 30_000)
    await Promise.all(deps.workers.map((w) => w.close(true)))
    clearTimeout(timer)
    await deps.connection.quit()
    await deps.closeDb()
    await deps.shutdownBrowserPool()
    exit(0)
  }
}

function main(): void {
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

  const shutdown = buildShutdown({ workers, connection, closeDb, shutdownBrowserPool })
  process.on('SIGTERM', (s) => { void shutdown(s) })
  process.on('SIGINT', (s) => { void shutdown(s) })
}

const entryArg = process.argv[1]
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  main()
}
