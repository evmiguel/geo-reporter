import crypto from 'node:crypto'

export function validateToken(given: string, stored: string): boolean {
  if (given.length === 0 || given.length !== stored.length) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(stored, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
