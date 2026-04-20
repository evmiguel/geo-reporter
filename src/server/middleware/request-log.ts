import type { MiddlewareHandler } from 'hono'

// Redact `?t=` and `?token=` query params from logged URLs. Plan 9 introduced
// capability-style URLs at /report/:id?t=<64-char-hex>. Without this wrapper
// every access log line would leak a working report token.
export function redactUrl(url: string): string {
  return url.replace(/([?&])(t|token)=[^&]*/g, '$1$2=REDACTED')
}

interface LogLine {
  msg: 'http'
  method: string
  status: number
  url: string
  ms: number
}

export function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now()
    await next()
    const line: LogLine = {
      msg: 'http',
      method: c.req.method,
      status: c.res.status,
      url: redactUrl(c.req.url.replace(/^https?:\/\/[^/]+/, '')),
      ms: Date.now() - start,
    }
    console.log(JSON.stringify(line))
  }
}
