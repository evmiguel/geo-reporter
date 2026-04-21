import { describe, it, expect, vi } from 'vitest'
import { ConsoleMailer } from '../../../src/mail/console-mailer.ts'

describe('ConsoleMailer.sendContactMessage', () => {
  it('logs the contact message to stdout with category + body', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mailer = new ConsoleMailer()
    await mailer.sendContactMessage({
      fromEmail: 'u@x', category: 'bug', body: 'something broke',
    })
    expect(spy).toHaveBeenCalled()
    const firstArg = spy.mock.calls[0]!.join(' ')
    expect(firstArg).toContain('contact-message')
    expect(firstArg).toContain('u@x')
    expect(firstArg).toContain('bug')
    expect(firstArg).toContain('something broke')
    spy.mockRestore()
  })

  it('truncates long bodies in the log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mailer = new ConsoleMailer()
    const longBody = 'x'.repeat(200)
    await mailer.sendContactMessage({
      fromEmail: 'u@x', category: 'other', body: longBody,
    })
    const firstArg = spy.mock.calls[0]!.join(' ')
    expect(firstArg).toContain('…')
    expect(firstArg).not.toContain('x'.repeat(200))
    spy.mockRestore()
  })
})
