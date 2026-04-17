import Redis from 'ioredis'

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null, // required by BullMQ workers
    enableReadyCheck: true,
  })
}
