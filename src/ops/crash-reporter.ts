import type { Mailer } from '../mail/types.ts'

export interface InstallCrashHandlersOptions {
  service: 'web' | 'worker'
  mailer: Mailer
  /** Grace window for the alert send before we force-exit. Default 3s. */
  gracePeriodMs?: number
  /** Injected for testing. Production passes no-op / real implementations. */
  onProcess?: NodeJS.Process
  exit?: (code: number) => never
  setTimeoutFn?: typeof setTimeout
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : JSON.stringify(reason))
}

/**
 * Install uncaughtException + unhandledRejection handlers that email an alert
 * before exiting. Does NOT catch import-time crashes — those exit before this
 * function runs. For startup failures, configure Railway's native "service
 * crashed" alerts in the dashboard.
 */
export function installCrashHandlers(opts: InstallCrashHandlersOptions): void {
  const proc = opts.onProcess ?? process
  const exit = opts.exit ?? (process.exit.bind(process) as (code: number) => never)
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout
  const graceMs = opts.gracePeriodMs ?? 3000

  let alerting = false
  const fatal = async (kind: 'uncaughtException' | 'unhandledRejection', err: Error): Promise<void> => {
    if (alerting) return // second crash during alert send — just exit
    alerting = true
    console.error(JSON.stringify({
      msg: 'fatal',
      service: opts.service,
      kind,
      message: err.message,
      stack: err.stack,
    }))
    // Race the email send against a grace deadline; we'd rather exit with a
    // lost alert than hang a crashed process indefinitely.
    await Promise.race([
      opts.mailer.sendCrashAlert({
        service: opts.service,
        kind,
        message: err.message,
        stack: err.stack ?? '',
        timestamp: new Date(),
      }).catch((e: unknown) => {
        console.error(JSON.stringify({ msg: 'crash-alert send failed', error: (e as Error).message }))
      }),
      new Promise<void>((resolve) => { setTimeoutFn(resolve, graceMs) }),
    ])
    exit(1)
  }

  proc.on('uncaughtException', (err) => { void fatal('uncaughtException', err) })
  proc.on('unhandledRejection', (reason) => { void fatal('unhandledRejection', toError(reason)) })
}
