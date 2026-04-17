import { env } from '../config/env.ts'
import { closeDb } from '../db/client.ts'
import { createRedis } from '../queue/redis.ts'
import { registerHealthWorker } from '../queue/workers/health.ts'

const connection = createRedis(env.REDIS_URL)
const workers = [registerHealthWorker(connection)]

console.log(JSON.stringify({ msg: 'worker started', workers: workers.length }))

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(JSON.stringify({ msg: 'worker shutting down', signal }))
  await Promise.all(workers.map((w) => w.close()))
  await connection.quit()
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
