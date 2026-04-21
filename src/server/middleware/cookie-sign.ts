import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HMAC_CHARS = 22

export type ParsedCookie =
  | { kind: 'signed'; uuid: string; hmac: string }
  | { kind: 'malformed' }

function hmacFor(uuid: string, key: string): string {
  return createHmac('sha256', key).update(uuid).digest('base64url').slice(0, HMAC_CHARS)
}

export function signCookie(uuid: string, key: string): string {
  return `${uuid}.${hmacFor(uuid, key)}`
}

export function verifyCookie(raw: string, key: string): string | null {
  const parts = raw.split('.')
  if (parts.length !== 2) return null
  const [uuid, hmac] = parts
  if (!uuid || !hmac || !UUID_V4_REGEX.test(uuid) || hmac.length !== HMAC_CHARS) return null
  const expected = hmacFor(uuid, key)
  const a = Buffer.from(expected)
  const b = Buffer.from(hmac)
  if (a.length !== b.length) return null
  return timingSafeEqual(a, b) ? uuid : null
}

export function parseCookie(raw: string): ParsedCookie {
  if (!raw) return { kind: 'malformed' }
  // No plain-UUID grace path — a bare UUID with no HMAC is treated as malformed
  // and triggers fresh cookie issuance. Any client still holding a pre-HMAC
  // cookie from pre-Plan-7 gets a new signed one on their next request; no
  // user-visible breakage.
  const parts = raw.split('.')
  if (parts.length !== 2) return { kind: 'malformed' }
  const [uuid, hmac] = parts
  if (!uuid || !hmac || !UUID_V4_REGEX.test(uuid) || hmac.length !== HMAC_CHARS) {
    return { kind: 'malformed' }
  }
  return { kind: 'signed', uuid, hmac }
}
