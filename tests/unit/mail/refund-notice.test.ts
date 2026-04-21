import { describe, it, expect, vi } from 'vitest'
import { ConsoleMailer } from '../../../src/mail/console-mailer.ts'

describe('ConsoleMailer.sendRefundNotice', () => {
  it('logs the refund notice to stdout', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mailer = new ConsoleMailer()
    await mailer.sendRefundNotice({ to: 'u@x', domain: 'stripe.com', kind: 'credit' })
    expect(spy).toHaveBeenCalled()
    const firstArg = spy.mock.calls[0]!.join(' ')
    expect(firstArg).toContain('refund-notice')
    expect(firstArg).toContain('u@x')
    expect(firstArg).toContain('stripe.com')
    spy.mockRestore()
  })
})
