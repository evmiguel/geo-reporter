import { describe, it, expect, vi } from 'vitest'

// Set required env vars before importing worker.ts, which transitively evaluates
// `env.DATABASE_URL` / `env.REDIS_URL` at module-load time via `db/client.ts`.
// Without these the env Proxy throws on first access during module init.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:54320/test'
process.env.REDIS_URL ??= 'redis://localhost:63790'

const { buildShutdown } = await import('../../../src/worker/worker.ts')

describe('worker shutdown handler', () => {
  it('calls worker.close(true) on each worker', async () => {
    const closeCalls: boolean[] = []
    const workers = [
      { close: (drain: boolean) => { closeCalls.push(drain); return Promise.resolve() } },
      { close: (drain: boolean) => { closeCalls.push(drain); return Promise.resolve() } },
    ] as never
    const quitMock = vi.fn(async () => 'OK' as const)
    const connection = { quit: quitMock }
    const closeDb = vi.fn(async () => {})
    const shutdownBrowserPool = vi.fn(async () => {})
    const shutdown = buildShutdown({ workers, connection, closeDb, shutdownBrowserPool })

    const exit = vi.fn() as unknown as (code: number) => never
    await shutdown('SIGTERM', exit)
    expect(closeCalls).toEqual([true, true])
    expect(quitMock).toHaveBeenCalled()
    expect(closeDb).toHaveBeenCalled()
    expect(shutdownBrowserPool).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('force-exits with code 1 if drain exceeds 30s', async () => {
    vi.useFakeTimers()
    const workers = [
      { close: () => new Promise<void>(() => { /* never resolve */ }) },
    ] as never
    const connection = { quit: async () => 'OK' as const } as never
    const closeDb = async () => {}
    const shutdownBrowserPool = async () => {}
    const shutdown = buildShutdown({ workers, connection, closeDb, shutdownBrowserPool })

    const exit = vi.fn() as unknown as (code: number) => never
    const p = shutdown('SIGTERM', exit)
    await vi.advanceTimersByTimeAsync(30_001)
    await Promise.resolve()
    expect(exit).toHaveBeenCalledWith(1)
    vi.useRealTimers()
    void p
  })
})
