import { describe, it, expect, vi } from 'vitest'
import { ConsoleMailer } from '../../../../src/mail/console-mailer.ts'

describe('ConsoleMailer', () => {
  it('logs email, expiry, and url to stdout', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mailer = new ConsoleMailer()
    const expiresAt = new Date('2030-01-01T12:00:00.000Z')
    await mailer.sendMagicLink({
      email: 'user@example.com',
      url: 'https://geo.example.com/auth/verify?t=abc123',
      expiresAt,
    })
    const allLogs = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(allLogs).toContain('user@example.com')
    expect(allLogs).toContain('https://geo.example.com/auth/verify?t=abc123')
    expect(allLogs).toContain(expiresAt.toISOString())
    spy.mockRestore()
  })
})
