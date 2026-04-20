import { describe, it, expect, vi } from 'vitest'
import { ResendMailer, MailerError } from '../../../src/mail/resend-mailer.ts'

interface SendArgs {
  from: string
  to: string
  subject: string
  text: string
  html: string
}

describe('ResendMailer', () => {
  it('sends a magic link with the expected from + subject + body', async () => {
    const sendSpy = vi.fn(async (_opts: SendArgs) => ({
      data: { id: 'm_123' },
      error: null,
    }))
    const m = new ResendMailer({
      apiKey: 're_test', from: 'noreply@send.example.com',
      client: { emails: { send: sendSpy } } as never,
    })
    await m.sendMagicLink({
      email: 'u@example.com',
      url: 'https://app.test/auth/verify?t=abc',
      expiresAt: new Date('2026-04-19T15:32:00Z'),
    })
    expect(sendSpy).toHaveBeenCalledOnce()
    const arg = sendSpy.mock.calls[0]![0]
    expect(arg.from).toBe('noreply@send.example.com')
    expect(arg.to).toBe('u@example.com')
    expect(arg.subject).toMatch(/sign in/i)
    expect(arg.text).toContain('https://app.test/auth/verify?t=abc')
    expect(arg.html).toContain('https://app.test/auth/verify?t=abc')
  })

  it('throws MailerError when Resend returns an error payload', async () => {
    const m = new ResendMailer({
      apiKey: 're_test', from: 'n@example.com',
      client: { emails: { send: async () => ({ data: null, error: { name: 'x', message: 'boom' } }) } } as never,
    })
    await expect(m.sendMagicLink({
      email: 'u@example.com', url: 'https://app.test/auth/verify?t=abc', expiresAt: new Date(),
    })).rejects.toBeInstanceOf(MailerError)
  })
})
