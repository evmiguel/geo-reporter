import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { installCrashHandlers } from '../../../src/ops/crash-reporter.ts'
import { FakeMailer } from '../_helpers/fake-mailer.ts'

type FakeProc = NodeJS.Process & { emit: (event: string, ...args: unknown[]) => boolean }

function makeFakeProcess(): FakeProc {
  return new EventEmitter() as unknown as FakeProc
}

describe('installCrashHandlers', () => {
  it('sends a crash alert on uncaughtException and exits 1', async () => {
    const mailer = new FakeMailer()
    const proc = makeFakeProcess()
    const exit = vi.fn() as unknown as (code: number) => never

    installCrashHandlers({
      service: 'worker', mailer, onProcess: proc, exit,
      setTimeoutFn: ((cb: () => void) => { cb(); return 0 as unknown as NodeJS.Timeout }) as typeof setTimeout,
    })

    const err = new Error('boom')
    proc.emit('uncaughtException', err)

    // Let the async fatal() finish
    await new Promise((r) => setImmediate(r))

    expect(mailer.crashAlerts).toHaveLength(1)
    expect(mailer.crashAlerts[0]).toMatchObject({
      service: 'worker', kind: 'uncaughtException', message: 'boom',
    })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('converts non-Error rejection values to Error before alerting', async () => {
    const mailer = new FakeMailer()
    const proc = makeFakeProcess()
    const exit = vi.fn() as unknown as (code: number) => never

    installCrashHandlers({
      service: 'web', mailer, onProcess: proc, exit,
      setTimeoutFn: ((cb: () => void) => { cb(); return 0 as unknown as NodeJS.Timeout }) as typeof setTimeout,
    })

    proc.emit('unhandledRejection', 'string-reason')
    await new Promise((r) => setImmediate(r))

    expect(mailer.crashAlerts).toHaveLength(1)
    expect(mailer.crashAlerts[0]!.message).toBe('string-reason')
    expect(mailer.crashAlerts[0]!.kind).toBe('unhandledRejection')
    expect(mailer.crashAlerts[0]!.service).toBe('web')
  })

  it('still exits if the mailer itself throws', async () => {
    const mailer = new FakeMailer()
    mailer.sendCrashAlert = vi.fn().mockRejectedValue(new Error('resend down'))
    const proc = makeFakeProcess()
    const exit = vi.fn() as unknown as (code: number) => never

    installCrashHandlers({
      service: 'worker', mailer, onProcess: proc, exit,
      setTimeoutFn: ((cb: () => void) => { cb(); return 0 as unknown as NodeJS.Timeout }) as typeof setTimeout,
    })

    proc.emit('uncaughtException', new Error('boom'))
    await new Promise((r) => setImmediate(r))

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('ignores recursive crashes during alert send', async () => {
    const mailer = new FakeMailer()
    mailer.sendCrashAlert = vi.fn().mockImplementation(async () => {
      // simulate a second crash mid-send
      proc.emit('uncaughtException', new Error('during send'))
    })
    const proc = makeFakeProcess()
    const exit = vi.fn() as unknown as (code: number) => never

    installCrashHandlers({
      service: 'worker', mailer, onProcess: proc, exit,
      setTimeoutFn: ((cb: () => void) => { cb(); return 0 as unknown as NodeJS.Timeout }) as typeof setTimeout,
    })

    proc.emit('uncaughtException', new Error('initial'))
    await new Promise((r) => setImmediate(r))

    // Only the first alert should have been attempted
    expect((mailer.sendCrashAlert as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })
})
