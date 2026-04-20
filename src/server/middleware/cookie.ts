import type { MiddlewareHandler } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { GradeStore } from '../../store/types.ts'
import { parseCookie, signCookie, verifyCookie } from './cookie-sign.ts'

export const COOKIE_NAME = 'ggcookie'
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

type Env = { Variables: { cookie: string } }

let graceWarned = false

async function issueFresh(
  c: Context<Env>,
  store: GradeStore,
  hmacKey: string,
  isProduction: boolean,
): Promise<string> {
  const uuid = crypto.randomUUID()
  const signed = signCookie(uuid, hmacKey)
  setCookie(c, COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  })
  await store.upsertCookie(uuid)
  return uuid
}

function reIssueSigned(
  c: Context<Env>,
  uuid: string,
  hmacKey: string,
  isProduction: boolean,
): void {
  const signed = signCookie(uuid, hmacKey)
  setCookie(c, COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  })
}

export function cookieMiddleware(
  store: GradeStore,
  isProduction: boolean,
  hmacKey: string,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const raw = getCookie(c, COOKIE_NAME)
    let uuid: string

    if (!raw) {
      uuid = await issueFresh(c, store, hmacKey, isProduction)
    } else {
      const parsed = parseCookie(raw)
      if (parsed.kind === 'plain') {
        if (!graceWarned) {
          console.log(JSON.stringify({
            msg: 'cookie_grace_path: accepted plain uuid, re-signed',
            tag: 'plain_uuid_cookie_migrated',
          }))
          graceWarned = true
        }
        await store.upsertCookie(parsed.uuid)
        reIssueSigned(c, parsed.uuid, hmacKey, isProduction)
        uuid = parsed.uuid
      } else if (parsed.kind === 'signed') {
        const verified = verifyCookie(raw, hmacKey)
        if (verified) {
          // Idempotently ensure the cookies row exists. Normally a no-op (the
          // row was created when the cookie was first issued), but heals the
          // case where a browser holds a valid signed cookie referencing a
          // UUID that no longer exists in the table — e.g. after a DB wipe.
          // Without this, downstream grade inserts would FK-fail.
          await store.upsertCookie(verified)
          uuid = verified
        } else {
          uuid = await issueFresh(c, store, hmacKey, isProduction)
        }
      } else {
        uuid = await issueFresh(c, store, hmacKey, isProduction)
      }
    }

    c.set('cookie', uuid)
    await next()
  }
}
