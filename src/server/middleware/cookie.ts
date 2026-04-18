import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { GradeStore } from '../../store/types.ts'

export const COOKIE_NAME = 'ggcookie'
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

type Env = { Variables: { cookie: string } }

export function cookieMiddleware(store: GradeStore, isProduction: boolean): MiddlewareHandler<Env> {
  return async (c, next) => {
    let cookie = getCookie(c, COOKIE_NAME)
    if (!cookie) {
      cookie = crypto.randomUUID()
      await store.upsertCookie(cookie)
      setCookie(c, COOKIE_NAME, cookie, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: isProduction,
        path: '/',
        maxAge: ONE_YEAR_SECONDS,
      })
    }
    c.set('cookie', cookie)
    await next()
  }
}
