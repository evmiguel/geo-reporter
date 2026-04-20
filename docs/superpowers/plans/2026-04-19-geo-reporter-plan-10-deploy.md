# Plan 10 — Deploy to Railway (soft launch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the feature-complete app on `https://geo.erikamiguel.com` with real email (Resend), live Stripe, and the soft-launch security gates from `docs/production-checklist.md`.

**Architecture:** Two services (web + worker) built from one multi-stage `Dockerfile` that bakes Chromium into the image. DB migrations run as a Railway pre-deploy hook. New middleware (request logger with token redaction, trusted-proxy-aware client-IP, checkout rate limit) lives under `src/server/middleware/`. SSRF defense ships as a shared helper used by both the fetch and Playwright paths. RealMailer is a single new file behind the existing `Mailer` interface; env-driven factory picks it over the dev `ConsoleMailer` when `RESEND_API_KEY` is set.

**Tech Stack:** Node 20, TypeScript 5, Hono 4, Drizzle + postgres-js, BullMQ 5, Playwright, Vitest 2, `resend@4`, `undici` (already transitively present).

**Spec:** `docs/superpowers/specs/2026-04-19-geo-reporter-plan-10-deploy-design.md`

---

## Phase A — Env + smallest code changes

### Task 1: Extend env schema

**Files:**
- Modify: `src/config/env.ts`
- Test: `tests/unit/config/env-deploy-vars.test.ts` (new)

- [ ] **Step 1: Read the existing env shape**

Run: `cat src/config/env.ts` to see the current schema. The project uses Zod via a lazy Proxy (see CLAUDE.md footgun). Existing vars include `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, `COOKIE_HMAC_KEY`, `PUBLIC_BASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_CREDITS_PRICE_ID`.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/config/env-deploy-vars.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadEnv } from '../../../src/config/env.ts'

describe('env — Plan 10 deploy vars', () => {
  it('accepts optional RESEND_API_KEY as a string', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'k'.repeat(32), PUBLIC_BASE_URL: 'http://localhost',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'a', PERPLEXITY_API_KEY: 'a',
      RESEND_API_KEY: 're_test',
    })
    expect(env.RESEND_API_KEY).toBe('re_test')
  })

  it('accepts optional MAIL_FROM as a string', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'k'.repeat(32), PUBLIC_BASE_URL: 'http://localhost',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'a', PERPLEXITY_API_KEY: 'a',
      MAIL_FROM: 'noreply@send.geo.erikamiguel.com',
    })
    expect(env.MAIL_FROM).toBe('noreply@send.geo.erikamiguel.com')
  })

  it('accepts optional TRUSTED_PROXIES as a comma-separated CIDR string', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'k'.repeat(32), PUBLIC_BASE_URL: 'http://localhost',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'a', PERPLEXITY_API_KEY: 'a',
      TRUSTED_PROXIES: '10.0.0.0/8,100.64.0.0/10',
    })
    expect(env.TRUSTED_PROXIES).toBe('10.0.0.0/8,100.64.0.0/10')
  })

  it('omits all three when not set', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', NODE_ENV: 'test',
      COOKIE_HMAC_KEY: 'k'.repeat(32), PUBLIC_BASE_URL: 'http://localhost',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'a', PERPLEXITY_API_KEY: 'a',
    })
    expect(env.RESEND_API_KEY).toBeUndefined()
    expect(env.MAIL_FROM).toBeUndefined()
    expect(env.TRUSTED_PROXIES).toBeUndefined()
  })
})
```

Note: the test signature assumes `loadEnv` is exported and accepts a source object. If the current module only exposes the `env` proxy, adjust the test to import `loadEnv` — it exists per the CLAUDE.md footgun note ("`loadEnv()` directly if you need the full object").

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/config/env-deploy-vars.test.ts`
Expected: FAIL — `RESEND_API_KEY` et al. not in the schema.

- [ ] **Step 4: Extend the schema**

Edit `src/config/env.ts`. Find the Zod `z.object({...})` schema. Add three optional fields:

```ts
  RESEND_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().email().optional(),
  TRUSTED_PROXIES: z.string().optional(),
```

Place them near the other optional fields (e.g., alongside `OPENROUTER_API_KEY`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/unit/config/env-deploy-vars.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run full unit suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts tests/unit/config/env-deploy-vars.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(config): accept RESEND_API_KEY, MAIL_FROM, TRUSTED_PROXIES env vars"
```

---

### Task 2: Truncate provider-error body

**Files:**
- Modify: `src/llm/providers/errors.ts`
- Test: `tests/unit/llm/providers/errors-truncate.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/llm/providers/errors-truncate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ProviderError } from '../../../../src/llm/providers/errors.ts'

describe('ProviderError message truncation', () => {
  it('truncates message bodies longer than 200 chars with an ellipsis', () => {
    const longBody = 'x'.repeat(500)
    const err = new ProviderError('claude', 500, 'server', `anthropic 500: ${longBody}`)
    expect(err.message.length).toBeLessThanOrEqual(220)
    expect(err.message.endsWith('…[truncated]')).toBe(true)
  })

  it('leaves short messages untouched', () => {
    const err = new ProviderError('claude', 500, 'server', 'anthropic 500: short')
    expect(err.message).toBe('anthropic 500: short')
  })

  it('preserves provider + status + kind fields', () => {
    const err = new ProviderError('claude', 400, 'insufficient_credit', 'a'.repeat(500))
    expect(err.provider).toBe('claude')
    expect(err.status).toBe(400)
    expect(err.kind).toBe('insufficient_credit')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/llm/providers/errors-truncate.test.ts`
Expected: FAIL — long message isn't truncated.

- [ ] **Step 3: Implement truncation in the constructor**

Open `src/llm/providers/errors.ts`. Find the `ProviderError` class. Replace the constructor body:

```ts
const MAX_MESSAGE_LEN = 200

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number | null,
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    const truncated = message.length > MAX_MESSAGE_LEN
      ? message.slice(0, MAX_MESSAGE_LEN) + '…[truncated]'
      : message
    super(truncated)
    this.name = 'ProviderError'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/llm/providers/errors-truncate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run full unit suite**

Run: `pnpm test`
Expected: all pass. Existing `anthropic.test.ts` and `fallback.test.ts` should still work — they assert error shape, not exact message length.

- [ ] **Step 6: Commit**

```bash
git add src/llm/providers/errors.ts tests/unit/llm/providers/errors-truncate.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "fix(llm): truncate ProviderError message body to 200 chars"
```

---

## Phase B — Middleware: request log, SSRF, trusted proxy, checkout rate limit

### Task 3: Request log middleware with token redaction

**Files:**
- Create: `src/server/middleware/request-log.ts`
- Modify: `src/server/app.ts` (mount the middleware)
- Test: `tests/unit/server/middleware/request-log.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server/middleware/request-log.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { redactUrl } from '../../../../src/server/middleware/request-log.ts'

describe('redactUrl', () => {
  it('replaces ?t=<token> with ?t=REDACTED', () => {
    expect(redactUrl('/report/abc?t=secret123')).toBe('/report/abc?t=REDACTED')
  })
  it('replaces ?token=<token> too', () => {
    expect(redactUrl('/auth/verify?token=abc')).toBe('/auth/verify?token=REDACTED')
  })
  it('preserves other query params', () => {
    expect(redactUrl('/report/abc?foo=bar&t=secret&baz=qux'))
      .toBe('/report/abc?foo=bar&t=REDACTED&baz=qux')
  })
  it('no-op when no sensitive param present', () => {
    expect(redactUrl('/report/abc?foo=bar')).toBe('/report/abc?foo=bar')
  })
  it('no-op when no query string', () => {
    expect(redactUrl('/healthz')).toBe('/healthz')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/server/middleware/request-log.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/server/middleware/request-log.ts`:

```ts
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
```

- [ ] **Step 4: Run test**

Run: `pnpm test tests/unit/server/middleware/request-log.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Mount in `buildApp`**

Open `src/server/app.ts`. Near the top of the `buildApp` function, before the `/healthz` route:

```ts
import { requestLog } from './middleware/request-log.ts'
// ... inside buildApp, before any route:
app.use('*', requestLog())
```

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/middleware/request-log.ts src/server/app.ts tests/unit/server/middleware/request-log.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(server): request log middleware with ?t=/?token= redaction"
```

---

### Task 4: SSRF helper

**Files:**
- Create: `src/scraper/ssrf.ts`
- Test: `tests/unit/scraper/ssrf.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scraper/ssrf.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { isPrivateAddress, SSRFBlockedError } from '../../../src/scraper/ssrf.ts'

describe('isPrivateAddress', () => {
  it('rejects RFC 1918 ranges', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.255.255.255')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('172.31.255.255')).toBe(true)
    expect(isPrivateAddress('192.168.1.1')).toBe(true)
  })

  it('rejects loopback', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('127.255.255.255')).toBe(true)
  })

  it('rejects link-local + cloud metadata IPs', () => {
    expect(isPrivateAddress('169.254.0.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
  })

  it('rejects CGNAT', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true)
    expect(isPrivateAddress('100.127.255.255')).toBe(true)
  })

  it('rejects 0.0.0.0/8 + multicast', () => {
    expect(isPrivateAddress('0.0.0.0')).toBe(true)
    expect(isPrivateAddress('224.0.0.1')).toBe(true)
  })

  it('rejects IPv6 loopback, link-local, ULA', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('fc00::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
  })

  it('allows public IPs', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})

describe('SSRFBlockedError', () => {
  it('carries host + address in the error message', () => {
    const e = new SSRFBlockedError('evil.test', '10.0.0.1')
    expect(e.message).toContain('evil.test')
    expect(e.message).toContain('10.0.0.1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/scraper/ssrf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/scraper/ssrf.ts`:

```ts
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'

export class SSRFBlockedError extends Error {
  constructor(readonly host: string, readonly address: string) {
    super(`SSRF block: ${host} resolved to private/local address ${address}`)
    this.name = 'SSRFBlockedError'
  }
}

// IPv4 CIDR check as integer ranges. We only need a handful of ranges so a
// switch on the first octet + fine-grained compare is simpler than a full
// cidr library.
function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function inRange(addrInt: number, startStr: string, endStr: string): boolean {
  const s = ipv4ToInt(startStr)!
  const e = ipv4ToInt(endStr)!
  return addrInt >= s && addrInt <= e
}

function isPrivateIPv4(addr: string): boolean {
  const n = ipv4ToInt(addr)
  if (n === null) return false
  return (
    inRange(n, '10.0.0.0', '10.255.255.255') ||
    inRange(n, '172.16.0.0', '172.31.255.255') ||
    inRange(n, '192.168.0.0', '192.168.255.255') ||
    inRange(n, '127.0.0.0', '127.255.255.255') ||
    inRange(n, '169.254.0.0', '169.254.255.255') ||
    inRange(n, '100.64.0.0', '100.127.255.255') ||
    inRange(n, '0.0.0.0', '0.255.255.255') ||
    inRange(n, '224.0.0.0', '239.255.255.255')
  )
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase()
  return (
    lower === '::1' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('ff')
  )
}

export function isPrivateAddress(addr: string): boolean {
  return addr.includes(':') ? isPrivateIPv6(addr) : isPrivateIPv4(addr)
}

export async function resolveSafeHost(host: string): Promise<LookupAddress> {
  const addrs = await lookup(host, { all: true })
  if (addrs.length === 0) throw new SSRFBlockedError(host, 'no-address')
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new SSRFBlockedError(host, a.address)
  }
  return addrs[0]!
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test tests/unit/scraper/ssrf.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scraper/ssrf.ts tests/unit/scraper/ssrf.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(scraper): SSRF-safe DNS resolution helper"
```

---

### Task 5: Wire SSRF into `scraper/fetch.ts`

**Files:**
- Modify: `src/scraper/fetch.ts`
- Test: `tests/unit/scraper/fetch-ssrf.test.ts` (new)

- [ ] **Step 1: Read the current `fetchHtml` shape**

Run: `grep -n "export" src/scraper/fetch.ts` to find the exports.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/scraper/fetch-ssrf.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchHtml, FetchError } from '../../../src/scraper/fetch.ts'

const savedEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = savedEnv
  vi.restoreAllMocks()
})

describe('fetchHtml SSRF defense', () => {
  it('rejects http://10.0.0.1 in production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(fetchHtml('http://10.0.0.1/')).rejects.toThrow(/SSRF block|FetchError/)
  })

  it('rejects http://169.254.169.254 (cloud metadata) in production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(fetchHtml('http://169.254.169.254/')).rejects.toThrow(/SSRF block|FetchError/)
  })

  it('allows http://localhost in development', async () => {
    process.env.NODE_ENV = 'development'
    // Stub fetch to avoid a real network call
    const stub = vi.fn(async () => new Response('<html></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    vi.stubGlobal('fetch', stub)
    const res = await fetchHtml('http://127.0.0.1/', { fetchFn: stub as typeof fetch })
    expect(res.html).toBe('<html></html>')
  })
})
```

Note: `fetchHtml` currently accepts an `opts` argument (e.g. `fetchTimeoutMs`). If it doesn't already accept a `fetchFn` override, add one in Step 3 — it's a small change that makes the test hermetic.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/scraper/fetch-ssrf.test.ts`
Expected: FAIL — prod URL is not rejected.

- [ ] **Step 4: Wire SSRF into `fetch.ts`**

Edit `src/scraper/fetch.ts`. At the top of `fetchHtml` (before any network call), add:

```ts
import { resolveSafeHost, SSRFBlockedError } from './ssrf.ts'
import { FetchError } from './fetch.ts'

// ... inside fetchHtml, after URL parse:
if (process.env.NODE_ENV === 'production') {
  try {
    await resolveSafeHost(parsedUrl.hostname)
  } catch (err) {
    if (err instanceof SSRFBlockedError) {
      throw new FetchError(`ssrf: ${err.message}`, 'network')
    }
    throw err
  }
}
```

If `fetchHtml` doesn't already destructure `fetchFn` from options, add it to the `opts` type and pass through to the actual fetch call.

- [ ] **Step 5: Run test**

Run: `pnpm test tests/unit/scraper/fetch-ssrf.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the existing scraper test**

Run: `pnpm test tests/unit/scraper`
Expected: PASS — the dev-env bypass keeps existing tests working.

- [ ] **Step 7: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/scraper/fetch.ts tests/unit/scraper/fetch-ssrf.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(scraper): reject private-IP hosts in production fetch path"
```

---

### Task 6: Wire SSRF into `scraper/render.ts`

**Files:**
- Modify: `src/scraper/render.ts`
- Test: `tests/unit/scraper/render-ssrf.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scraper/render-ssrf.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from '../../../src/scraper/render.ts'
import { FetchError } from '../../../src/scraper/fetch.ts'

const savedEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = savedEnv
  vi.restoreAllMocks()
})

describe('render SSRF defense', () => {
  it('throws before launching Playwright when host resolves to a private IP (prod)', async () => {
    process.env.NODE_ENV = 'production'
    await expect(render('http://10.0.0.1/')).rejects.toThrow(/SSRF block|FetchError/)
  })

  it('rejects cloud metadata IP in production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(render('http://169.254.169.254/')).rejects.toThrow(/SSRF block|FetchError/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/scraper/render-ssrf.test.ts`
Expected: FAIL — private IPs reach Playwright.

- [ ] **Step 3: Wire SSRF at the top of `render`**

Edit `src/scraper/render.ts`. Inside the `render(url, opts)` method of `BrowserPool` (and/or the standalone `render()` export), BEFORE `page.goto`, add:

```ts
import { resolveSafeHost, SSRFBlockedError } from './ssrf.ts'

// ... inside the method:
if (process.env.NODE_ENV === 'production') {
  try {
    await resolveSafeHost(new URL(url).hostname)
  } catch (err) {
    if (err instanceof SSRFBlockedError) {
      throw new FetchError(`ssrf: ${err.message}`, 'network')
    }
    throw err
  }
}
```

Apply this BEFORE `withPage(...)` is invoked so we don't waste a browser page on a doomed URL.

- [ ] **Step 4: Run test**

Run: `pnpm test tests/unit/scraper/render-ssrf.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run full scraper test suite (no real Chromium)**

Run: `pnpm test tests/unit/scraper`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/scraper/render.ts tests/unit/scraper/render-ssrf.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(scraper): SSRF check before Playwright page.goto"
```

---

### Task 7: Trusted-proxy enforcement in client-IP middleware

**Files:**
- Modify: `src/server/middleware/client-ip.ts`
- Modify: `src/server/app.ts` (pass trustedProxies + isProduction)
- Test: `tests/unit/server/middleware/client-ip-trusted.test.ts` (new)

- [ ] **Step 1: Read current `client-ip.ts`**

Run: `cat src/server/middleware/client-ip.ts`

- [ ] **Step 2: Write the failing test**

Create `tests/unit/server/middleware/client-ip-trusted.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

type Env = { Variables: { clientIp: string } }

function buildApp(opts: { trustedProxies: string[]; isProduction: boolean }) {
  const app = new Hono<Env>()
  app.use('*', clientIp(opts))
  app.get('/', (c) => c.json({ ip: c.var.clientIp }))
  return app
}

describe('clientIp — trusted-proxy enforcement', () => {
  it('production: ignores XFF when peer not in allow-list', async () => {
    const app = buildApp({ trustedProxies: ['10.0.0.0/8'], isProduction: true })
    const res = await app.request('/', {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        // no peer IP → defaults to empty, not in CIDR
      },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).not.toBe('1.2.3.4')
  })

  it('production: honors XFF when peer is in allow-list', async () => {
    const app = buildApp({ trustedProxies: ['10.0.0.0/8'], isProduction: true })
    const res = await app.request('/', {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '10.1.2.3',  // allow-listed peer
      },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('1.2.3.4')
  })

  it('development: honors XFF unconditionally (ergonomic testing)', async () => {
    const app = buildApp({ trustedProxies: [], isProduction: false })
    const res = await app.request('/', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    })
    const body = await res.json() as { ip: string }
    expect(body.ip).toBe('1.2.3.4')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/server/middleware/client-ip-trusted.test.ts`
Expected: FAIL — middleware doesn't accept options.

- [ ] **Step 4: Implement trusted-proxy logic**

Replace `src/server/middleware/client-ip.ts`:

```ts
import type { MiddlewareHandler } from 'hono'

type Env = { Variables: { clientIp: string } }

interface ClientIpOptions {
  trustedProxies: string[]   // CIDR list; empty = trust nothing in prod
  isProduction: boolean
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function inCidr(addr: string, cidr: string): boolean {
  const [netStr, prefixStr] = cidr.split('/')
  const prefix = Number(prefixStr)
  const net = ipv4ToInt(netStr!)
  const n = ipv4ToInt(addr)
  if (net === null || n === null || Number.isNaN(prefix)) return false
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (n & mask) === (net & mask)
}

function trustedPeer(peer: string, cidrs: string[]): boolean {
  return cidrs.some((c) => inCidr(peer, c))
}

export function clientIp(opts: ClientIpOptions): MiddlewareHandler<Env> {
  return async (c, next) => {
    const peer = c.req.header('x-real-ip') ?? ''
    const xff = c.req.header('x-forwarded-for')
    const honorXff =
      xff !== undefined
      && (!opts.isProduction || trustedPeer(peer, opts.trustedProxies))
    const ip = honorXff ? xff.split(',')[0]!.trim() : peer
    c.set('clientIp', ip)
    await next()
  }
}
```

- [ ] **Step 5: Update `app.ts` to pass options**

Open `src/server/app.ts`. Find every `clientIp()` call (there are several scopes — grade, auth, billing). Replace with:

```ts
const trustedProxies = (deps.env.TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
const clientIpOpts = { trustedProxies, isProduction: deps.env.NODE_ENV === 'production' }
// ... and use clientIp(clientIpOpts) everywhere it appears
```

Declare `clientIpOpts` once at the top of `buildApp(deps)` so all scopes share it.

- [ ] **Step 6: Run the new test**

Run: `pnpm test tests/unit/server/middleware/client-ip-trusted.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run existing client-ip test**

Run: `pnpm test tests/unit/server/middleware/client-ip.test.ts`
Expected: may FAIL because the signature changed. Update those tests to pass `{ trustedProxies: [], isProduction: false }`. The behavior for `isProduction: false` is equivalent to the old unconditional-trust behavior, so tests that passed before should still pass with this default.

- [ ] **Step 8: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 9: Extend `ServerDeps.env` type to include `TRUSTED_PROXIES`**

If `src/server/deps.ts` has an explicit `env` sub-shape, add `TRUSTED_PROXIES: string | null` to it. Otherwise (if it re-exposes the loaded env), no change needed.

- [ ] **Step 10: Commit**

```bash
git add src/server/middleware/client-ip.ts src/server/app.ts src/server/deps.ts tests/unit/server/middleware/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(server): TRUSTED_PROXIES allow-list for X-Forwarded-For"
```

---

### Task 8: Rate limit on `/billing/checkout`

**Files:**
- Modify: `src/server/routes/billing.ts`
- Modify: `src/web/lib/api.ts` (new result kind)
- Test: `tests/unit/server/routes/billing-checkout-rate-limit.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server/routes/billing-checkout-rate-limit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeStripe } from '../../_helpers/fake-stripe.ts'
import { billingRouter } from '../../../../src/server/routes/billing.ts'
import { cookieMiddleware } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

async function build() {
  const store = makeFakeStore()
  const billing = new FakeStripe()
  const redisCalls: Array<{ op: string; args: unknown[] }> = []
  const redis = {
    zremrangebyscore: async () => 0,
    zcard: async () => redisCalls.filter((c) => c.op === 'zadd').length,
    zadd: async (...args: unknown[]) => { redisCalls.push({ op: 'zadd', args }); return 1 },
    zrange: async () => [],
    expire: async () => 1,
  } as unknown as import('ioredis').default

  const app = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp({ trustedProxies: [], isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/billing', billingRouter({
    store, billing, redis,
    priceId: 'price_test_abc',
    creditsPriceId: 'price_test_credits',
    publicBaseUrl: 'http://localhost:5173',
    webhookSecret: 'whsec_test_fake',
    reportQueue: null as unknown as import('bullmq').Queue,
  }))
  return { app, store, redisCalls }
}

async function issueCookie(app: Hono): Promise<string> {
  const res = await app.fetch(new Request('http://test/billing/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gradeId: 'not-uuid' }),
  }))
  const raw = (res.headers.get('set-cookie') ?? '').split('ggcookie=')[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('POST /billing/checkout — rate limit', () => {
  it('returns 429 paywall=checkout_throttled after 10 attempts within 1h', async () => {
    const { app, store, redisCalls } = await build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('rl@example.com')
    await store.upsertCookie(uuid, user.id)

    // Simulate the bucket already at capacity by pre-populating redisCalls
    for (let i = 0; i < 10; i++) redisCalls.push({ op: 'zadd', args: [] })

    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie: uuid, status: 'done',
    })
    const res = await app.fetch(new Request('http://test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ggcookie=${cookie}` },
      body: JSON.stringify({ gradeId: grade.id }),
    }))
    expect(res.status).toBe(429)
    const body = await res.json() as { error: string; paywall: string }
    expect(body.error).toBe('rate_limited')
    expect(body.paywall).toBe('checkout_throttled')
  })
})
```

Note: the test depends on `billingRouter` accepting a `redis` dep. If the router currently doesn't, Step 4 adds it.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/server/routes/billing-checkout-rate-limit.test.ts`
Expected: FAIL — either no rate limit, or the router doesn't accept `redis`.

- [ ] **Step 3: Add `redis` to `BillingRouterDeps`**

Open `src/server/routes/billing.ts`. In the `BillingRouterDeps` interface, add:

```ts
import type Redis from 'ioredis'

export interface BillingRouterDeps {
  // ... existing fields ...
  redis: Redis
}
```

- [ ] **Step 4: Wire the rate-limit check at the top of `/checkout`**

Still in `src/server/routes/billing.ts`. At the top of the `/checkout` handler (inside the `zValidator` callback body), BEFORE the grade lookup:

```ts
import { peekBucket, addToBucket } from '../middleware/bucket.ts'

// ... inside the handler:
const bucketCfg = {
  key: `bucket:checkout:${c.var.cookie}`,
  limit: 10,
  windowMs: 3_600_000,
}
const peek = await peekBucket(deps.redis, bucketCfg, Date.now())
if (!peek.allowed) {
  return c.json({
    error: 'rate_limited' as const,
    paywall: 'checkout_throttled' as const,
    retryAfter: peek.retryAfter,
  }, 429)
}
await addToBucket(deps.redis, bucketCfg, Date.now())
```

- [ ] **Step 5: Pass `redis` from `buildApp`**

Open `src/server/app.ts`. Find where `billingRouter({ ... })` is instantiated. Add `redis: deps.redis`.

- [ ] **Step 6: Run the new test**

Run: `pnpm test tests/unit/server/routes/billing-checkout-rate-limit.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Update existing billing-checkout tests for the new dep**

Run: `pnpm test tests/unit/server/routes/billing-checkout.test.ts`
Expected: may fail because the `build()` helper in that test now needs a `redis` in the router's deps. Update the fixture to include a stub Redis (copy the one from the new test).

- [ ] **Step 8: Extend the frontend API wrapper**

Open `src/web/lib/api.ts`. Find `CheckoutResult`. Add a new kind:

```ts
export type CheckoutResult =
  // ... existing ...
  | { ok: false; kind: 'rate_limited'; retryAfter: number }
```

In `postBillingCheckout`, add a branch for 429:

```ts
if (res.status === 429) {
  const body = (await res.json().catch(() => ({}))) as { retryAfter?: number }
  return { ok: false, kind: 'rate_limited', retryAfter: body.retryAfter ?? 3600 }
}
```

- [ ] **Step 9: Handle the new kind in `BuyReportButton`**

Open `src/web/components/BuyReportButton.tsx`. In the catch list for `postBillingCheckout`, add:

```ts
if (result.kind === 'rate_limited') {
  setError(`Too many checkout attempts. Try again in ${Math.ceil(result.retryAfter / 60)} min.`)
  return
}
```

- [ ] **Step 10: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/server/routes/billing.ts src/server/app.ts src/web/lib/api.ts src/web/components/BuyReportButton.tsx tests/unit/server/routes/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(billing): per-cookie rate limit on /checkout (10/h)"
```

---

## Phase C — Worker + mailer

### Task 9: Graceful worker shutdown

**Files:**
- Modify: `src/worker/worker.ts`
- Test: `tests/unit/worker/shutdown.test.ts` (new)

- [ ] **Step 1: Read current shutdown handler**

Run: `cat src/worker/worker.ts`

- [ ] **Step 2: Write the failing test**

Create `tests/unit/worker/shutdown.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildShutdown } from '../../../src/worker/worker.ts'

describe('worker shutdown handler', () => {
  it('calls worker.close(true) on each worker', async () => {
    const closeCalls: boolean[] = []
    const workers = [
      { close: (drain: boolean) => { closeCalls.push(drain); return Promise.resolve() } },
      { close: (drain: boolean) => { closeCalls.push(drain); return Promise.resolve() } },
    ] as never
    const connection = { quit: vi.fn(async () => 'OK' as const) } as never
    const closeDb = vi.fn(async () => {})
    const shutdownBrowserPool = vi.fn(async () => {})
    const shutdown = buildShutdown({ workers, connection, closeDb, shutdownBrowserPool })

    const exit = vi.fn() as unknown as (code: number) => never
    await shutdown('SIGTERM', exit)
    expect(closeCalls).toEqual([true, true])
    expect(connection.quit).toHaveBeenCalled()
    expect(closeDb).toHaveBeenCalled()
    expect(shutdownBrowserPool).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('force-exits with code 1 if drain exceeds 30s', async () => {
    vi.useFakeTimers()
    const workers = [
      { close: () => new Promise<void>(() => { /* never resolve */ }) },
    ] as never
    const connection = { quit: async () => 'OK' as const } as never
    const closeDb = async () => {}
    const shutdownBrowserPool = async () => {}
    const shutdown = buildShutdown({ workers, connection, closeDb, shutdownBrowserPool })

    const exit = vi.fn() as unknown as (code: number) => never
    const p = shutdown('SIGTERM', exit)
    await vi.advanceTimersByTimeAsync(30_001)
    await Promise.resolve()
    expect(exit).toHaveBeenCalledWith(1)
    vi.useRealTimers()
    void p
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/worker/shutdown.test.ts`
Expected: FAIL — `buildShutdown` not exported.

- [ ] **Step 4: Refactor `worker.ts` to export `buildShutdown`**

Edit `src/worker/worker.ts`. Extract the shutdown handler into a testable factory:

```ts
interface ShutdownDeps {
  workers: Array<{ close: (drain: boolean) => Promise<void> }>
  connection: { quit: () => Promise<'OK' | number> }
  closeDb: () => Promise<void>
  shutdownBrowserPool: () => Promise<void>
}

export function buildShutdown(deps: ShutdownDeps): (signal: NodeJS.Signals, exit?: (code: number) => never) => Promise<void> {
  return async (signal, exit = process.exit as (code: number) => never) => {
    console.log(JSON.stringify({ msg: 'worker shutting down', signal }))
    const timer = setTimeout(() => {
      console.log(JSON.stringify({ msg: 'drain timeout, forcing close' }))
      exit(1)
    }, 30_000)
    await Promise.all(deps.workers.map((w) => w.close(true)))
    clearTimeout(timer)
    await deps.connection.quit()
    await deps.closeDb()
    await deps.shutdownBrowserPool()
    exit(0)
  }
}
```

Wire it at the bottom of the file:

```ts
const shutdown = buildShutdown({ workers, connection, closeDb, shutdownBrowserPool })
process.on('SIGTERM', (s) => { void shutdown(s) })
process.on('SIGINT', (s) => { void shutdown(s) })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/unit/worker/shutdown.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/worker/worker.ts tests/unit/worker/shutdown.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(worker): graceful shutdown drains in-flight jobs (30s timeout)"
```

---

### Task 10: Resend mailer

**Files:**
- Install: `resend` runtime dep
- Create: `src/mail/resend-mailer.ts`
- Test: `tests/unit/mail/resend-mailer.test.ts` (new)

- [ ] **Step 1: Install the Resend SDK**

Run: `pnpm add resend@4`
Expected: adds `resend` to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/mail/resend-mailer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { ResendMailer } from '../../../src/mail/resend-mailer.ts'

describe('ResendMailer', () => {
  it('sends a magic link with the expected from + subject + body', async () => {
    const sendSpy = vi.fn(async () => ({ data: { id: 'm_123' }, error: null }))
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
    const arg = sendSpy.mock.calls[0]![0] as { from: string; to: string; subject: string; text: string; html: string }
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
    })).rejects.toThrow(/resend/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/mail/resend-mailer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/mail/resend-mailer.ts`:

```ts
import { Resend } from 'resend'
import type { Mailer } from './types.ts'

// Allow injecting a mock client in tests; default to real Resend.
interface ResendLikeClient {
  emails: {
    send: (opts: {
      from: string; to: string; subject: string; text: string; html: string
    }) => Promise<{ data: { id: string } | null; error: { name: string; message: string } | null }>
  }
}

export interface ResendMailerOptions {
  apiKey: string
  from: string
  client?: ResendLikeClient
}

export class MailerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailerError'
  }
}

function fmtExpiry(d: Date): string {
  const minutes = Math.max(0, Math.round((d.getTime() - Date.now()) / 60_000))
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.round(minutes / 60)
  return `in ${hours} hr`
}

function html(url: string, expiresIn: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
    <h2 style="font-size:20px;margin-bottom:16px">Sign in to GEO Reporter</h2>
    <p>Click the link below to sign in. It expires ${expiresIn}.</p>
    <p><a href="${url}" style="display:inline-block;background:#ff7a1a;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">Sign in</a></p>
    <p style="color:#888;font-size:12px;margin-top:24px">If you didn't request this, you can ignore this email.</p>
  </body></html>`
}

export class ResendMailer implements Mailer {
  private readonly client: ResendLikeClient
  private readonly from: string

  constructor(opts: ResendMailerOptions) {
    this.client = opts.client ?? new Resend(opts.apiKey)
    this.from = opts.from
  }

  async sendMagicLink(input: { email: string; url: string; expiresAt: Date }): Promise<void> {
    const expiresIn = fmtExpiry(input.expiresAt)
    const { error } = await this.client.emails.send({
      from: this.from,
      to: input.email,
      subject: 'Sign in to GEO Reporter',
      text: `Click to sign in: ${input.url}\n\nThis link expires ${expiresIn}.`,
      html: html(input.url, expiresIn),
    })
    if (error) throw new MailerError(`resend: ${error.message}`)
  }
}
```

- [ ] **Step 5: Run test**

Run: `pnpm test tests/unit/mail/resend-mailer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/mail/resend-mailer.ts tests/unit/mail/resend-mailer.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(mail): ResendMailer implementing the Mailer interface"
```

---

### Task 11: Mailer factory in `server.ts`

**Files:**
- Modify: `src/server/server.ts`

- [ ] **Step 1: Read current mailer wiring**

Run: `grep -n "Mailer\|ConsoleMailer" src/server/server.ts`

- [ ] **Step 2: Replace the mailer instantiation with a factory**

Edit `src/server/server.ts`. Find the `ConsoleMailer` instantiation. Replace with:

```ts
import { ResendMailer } from '../mail/resend-mailer.ts'
import { ConsoleMailer } from '../mail/console-mailer.ts'
import type { Mailer } from '../mail/types.ts'

const mailer: Mailer =
  env.RESEND_API_KEY !== undefined && env.MAIL_FROM !== undefined
    ? new ResendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM })
    : new ConsoleMailer()

if (env.NODE_ENV !== 'production' && !(mailer instanceof ResendMailer)) {
  console.log(JSON.stringify({ msg: 'mailer: using ConsoleMailer (set RESEND_API_KEY + MAIL_FROM for real email)' }))
}
```

(Adapt the import path to wherever `ConsoleMailer` lives today.)

- [ ] **Step 3: Run full test + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. No new tests; the factory is trivial and exercised by integration tests.

- [ ] **Step 4: Commit**

```bash
git add src/server/server.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(server): pick ResendMailer when RESEND_API_KEY is set"
```

---

## Phase D — Build infra

### Task 12: `.dockerignore`

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

Create `/home/erika/repos/geo-grader-v3/.dockerignore` with:

```
# Version control
.git/
.gitignore
.github/

# Local dev state
.worktrees/
.superpowers/
.env
.env.*
!.env.example

# Build outputs
dist/
node_modules/

# Tests & docs (not needed in runtime image)
tests/
docs/
CLAUDE.md
README.md
*.md

# Editor / OS
.vscode/
.idea/
.DS_Store
Thumbs.db

# Worktrees & misc
coverage/
.nyc_output/
*.log
```

- [ ] **Step 2: Sanity-check that critical files still land in build context**

Run: `docker build --no-cache -f Dockerfile . 2>&1 | head -5`
Expected: first line is `=> transferring context: <small-size>` — a few MB, not hundreds.

If the command fails because the Dockerfile doesn't exist yet, skip — Task 13 creates it.

- [ ] **Step 3: Commit**

```bash
git add .dockerignore
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "build: add .dockerignore (keep build context small)"
```

---

### Task 13: Dockerfile

**Files:**
- Create: `Dockerfile`
- Modify: `package.json` (add `db:migrate:prod` script if missing)

- [ ] **Step 1: Create the Dockerfile**

Create `/home/erika/repos/geo-grader-v3/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- deps ----
FROM node:20-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Playwright sysdeps (keep in sync with README + CLAUDE.md)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnspr4 libnss3 libasound2t64 libgtk-3-0 libgbm1 \
    ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.6.0 --activate

# Prod dependencies only (keeps image small)
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

# Bake Chromium into the image so cold-start doesn't download it
RUN pnpm exec playwright install chromium

# App artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY drizzle.config.ts ./

# Default to the web server; worker service overrides CMD via Railway start-command.
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Build locally to verify**

Run: `docker build -t geo-grader-v3:local .`
Expected: `Successfully built ...` / `naming to docker.io/library/geo-grader-v3:local`. First build may take 5-10 min (Chromium download). Subsequent builds use the pnpm cache mount.

- [ ] **Step 3: Inspect image size**

Run: `docker images geo-grader-v3:local`
Expected: ~600-900 MB (Chromium is the bulk). If over 1.5 GB, something's wrong — investigate.

- [ ] **Step 4: Smoke-test the web image locally**

Run:

```bash
docker run --rm -p 7777:7777 \
  -e DATABASE_URL=postgres://geo:geo@host.docker.internal:54320/geo \
  -e REDIS_URL=redis://host.docker.internal:63790 \
  -e NODE_ENV=production \
  -e COOKIE_HMAC_KEY=testkey-exactly-32-chars-long-aa \
  -e PUBLIC_BASE_URL=http://localhost:7777 \
  -e ANTHROPIC_API_KEY=x -e OPENAI_API_KEY=x -e GEMINI_API_KEY=x -e PERPLEXITY_API_KEY=x \
  geo-grader-v3:local
```

(Adjust host URL if not on macOS/Windows — Linux uses `--add-host=host.docker.internal:host-gateway`.)

In another terminal: `curl http://localhost:7777/healthz`
Expected: `{"ok":true,"db":true,"redis":true}` (provided docker-compose postgres + redis are running).

Kill the container with Ctrl-C.

- [ ] **Step 5: Ensure `drizzle-kit` is accessible for the pre-deploy hook**

Railway's pre-deploy runs `pnpm --package=drizzle-kit@0.33 dlx drizzle-kit migrate --config=drizzle.config.ts`. Sanity check by running inside the container:

```bash
docker run --rm -e NODE_ENV=production geo-grader-v3:local \
  pnpm --package=drizzle-kit@0.33 dlx drizzle-kit --help
```

Expected: drizzle-kit help output.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "build: multi-stage Dockerfile with Playwright + Chromium"
```

---

## Phase E — Smoke script + integration test

### Task 14: Post-deploy smoke script

**Files:**
- Create: `scripts/smoke-prod.ts`
- Modify: `package.json` (add a convenience script)

- [ ] **Step 1: Create `scripts/smoke-prod.ts`**

```ts
#!/usr/bin/env tsx
/**
 * Post-deploy smoke test. Reads PUBLIC_BASE_URL from env (or first CLI arg),
 * issues a grade on a benign URL, waits for done, and asserts the response
 * shape. Exits non-zero on any failure.
 *
 * Does NOT exercise Stripe (live mode — no test cards). Paid-flow smoke is
 * manual.
 */

const baseUrl = process.argv[2] ?? process.env.PUBLIC_BASE_URL
if (!baseUrl) {
  console.error('usage: smoke-prod.ts <BASE_URL>  # or set PUBLIC_BASE_URL')
  process.exit(2)
}

const GRADE_URL = 'https://example.com'
const TIMEOUT_MS = 90_000

async function main(): Promise<void> {
  console.log(`smoke-prod: target ${baseUrl}`)

  // 1) healthz
  const hz = await fetch(`${baseUrl}/healthz`)
  if (hz.status !== 200) throw new Error(`/healthz: ${hz.status}`)
  const hzBody = (await hz.json()) as { ok: boolean; db: boolean; redis: boolean }
  if (!hzBody.ok) throw new Error(`/healthz unhealthy: ${JSON.stringify(hzBody)}`)
  console.log('✓ /healthz')

  // 2) POST /grades (no cookie → gets one issued)
  const jar: string[] = []
  const postRes = await fetch(`${baseUrl}/grades`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: GRADE_URL }),
  })
  if (postRes.status !== 202) {
    const body = await postRes.text()
    throw new Error(`POST /grades: ${postRes.status} ${body}`)
  }
  const setCookie = postRes.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]!
  jar.push(cookie)
  const { gradeId } = (await postRes.json()) as { gradeId: string }
  console.log(`✓ POST /grades → ${gradeId}`)

  // 3) poll GET /grades/:id until done
  const deadline = Date.now() + TIMEOUT_MS
  let last = 'queued'
  while (Date.now() < deadline) {
    const r = await fetch(`${baseUrl}/grades/${gradeId}`, {
      headers: { cookie: jar.join('; ') },
    })
    if (r.status !== 200) throw new Error(`GET /grades/${gradeId}: ${r.status}`)
    const b = (await r.json()) as { status: string; overall: number | null; scores: unknown }
    if (b.status !== last) {
      last = b.status
      console.log(`  grade status: ${last}`)
    }
    if (b.status === 'done') {
      if (typeof b.overall !== 'number') throw new Error('done but overall is null')
      console.log(`✓ grade done in ${Math.round((Date.now() - (deadline - TIMEOUT_MS)) / 1000)}s overall=${b.overall}`)
      console.log('smoke-prod: all checks passed')
      return
    }
    if (b.status === 'failed') throw new Error('grade failed')
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error(`grade not done after ${TIMEOUT_MS / 1000}s (last status: ${last})`)
}

main().catch((err) => {
  console.error('smoke-prod: FAILED —', err instanceof Error ? err.message : err)
  process.exit(1)
})
```

- [ ] **Step 2: Add a package script**

Open `package.json`. Add to `"scripts"`:

```json
"smoke:prod": "tsx scripts/smoke-prod.ts"
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-prod.ts package.json
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(scripts): smoke-prod.ts — healthz + free-tier grade end-to-end"
```

---

### Task 15: Integration smoke test

**Files:**
- Test: `tests/integration/deploy-smoke.test.ts` (new)

- [ ] **Step 1: Write the test**

Create `tests/integration/deploy-smoke.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Worker } from 'bullmq'
import type { Hono } from 'hono'
import { buildApp } from '../../src/server/app.ts'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'
import { createRedis } from '../../src/queue/redis.ts'
import { registerRunGradeWorker } from '../../src/queue/workers/run-grade/index.ts'
import { MockProvider } from '../../src/llm/providers/index.ts'
import { shutdownBrowserPool } from '../../src/scraper/render.ts'

describe('deploy smoke (testcontainers)', () => {
  let testDb: TestDb
  let redisContainer: StartedTestContainer
  let redis: ReturnType<typeof createRedis>
  let worker: Worker
  let app: Hono

  beforeAll(async () => {
    testDb = await startTestDb()
    redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
    redis = createRedis(redisUrl)
    const store = new PostgresStore(testDb.db)

    // Stubbed providers: enough to satisfy the free-tier grade path.
    const mock = (id: 'claude' | 'gpt' | 'gemini' | 'perplexity') =>
      new MockProvider({ id, responses: { default: JSON.stringify({ accuracy: 80, coverage: 80, notes: '' }) } })
    const providers = { claude: mock('claude'), gpt: mock('gpt'), gemini: mock('gemini'), perplexity: mock('perplexity') }

    const mockScrape = async () => ({
      rendered: false,
      html: '<html><head><title>Example</title></head><body><h1>Hi</h1></body></html>',
      text: 'This is an example site with enough content to satisfy the minimum threshold for scraping, accuracy probing, and all downstream scoring heuristics.',
      structured: {} as never,
    })

    worker = registerRunGradeWorker(
      { store, redis, providers, scrapeFn: mockScrape as never },
      redis,
    )
    app = buildApp({
      store, redis, redisFactory: () => redis,
      mailer: { sendMagicLink: async () => {} } as never,
      billing: null,
      reportQueue: { add: async () => {} } as never,
      pingDb: async () => true, pingRedis: async () => true,
      env: {
        NODE_ENV: 'test', COOKIE_HMAC_KEY: 'k'.repeat(32),
        PUBLIC_BASE_URL: 'http://localhost',
        STRIPE_PRICE_ID: null, STRIPE_WEBHOOK_SECRET: null, STRIPE_CREDITS_PRICE_ID: null,
        TRUSTED_PROXIES: null,
      },
    })
  }, 180_000)

  afterAll(async () => {
    await worker.close()
    await redis.quit()
    await shutdownBrowserPool()
    await testDb.stop()
    await redisContainer.stop()
  })

  it('healthz + anon grade end-to-end completes successfully', async () => {
    const hz = await app.request('/healthz')
    expect(hz.status).toBe(200)

    const postRes = await app.request('/grades', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(postRes.status).toBe(202)
    const setCookie = postRes.headers.get('set-cookie')!
    const cookie = setCookie.split(';')[0]!
    const { gradeId } = (await postRes.json()) as { gradeId: string }

    // Poll until done
    const start = Date.now()
    while (Date.now() - start < 60_000) {
      const r = await app.request(`/grades/${gradeId}`, { headers: { cookie } })
      const b = (await r.json()) as { status: string }
      if (b.status === 'done') break
      if (b.status === 'failed') throw new Error('grade failed')
      await new Promise((r) => setTimeout(r, 500))
    }
    const final = await app.request(`/grades/${gradeId}`, { headers: { cookie } })
    const body = (await final.json()) as { status: string; overall: number | null }
    expect(body.status).toBe('done')
    expect(typeof body.overall).toBe('number')
  }, 120_000)
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm test:integration tests/integration/deploy-smoke.test.ts`
Expected: PASS (takes 60-90s).

- [ ] **Step 3: Run full integration suite (regression check)**

Run: `pnpm test:integration`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/deploy-smoke.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "test(integration): deploy-smoke end-to-end against testcontainers"
```

---

## Phase F — Runbook

### Task 16: Deploy runbook

**Files:**
- Create: `docs/deploy-runbook.md`

- [ ] **Step 1: Create the runbook**

Create `docs/deploy-runbook.md`:

```markdown
# Deploy runbook — Plan 10 (Railway, soft launch)

Step-by-step guide for deploying geo-grader-v3 to `https://geo.erikamiguel.com`. Run this once. If the infra needs to be rebuilt from scratch, redo every step.

## Prerequisites (one-time accounts — do in parallel with code work)

- **Resend account** (https://resend.com). Add sending domain `send.geo.erikamiguel.com`. Resend spits out 3 DNS records (SPF TXT, DKIM CNAME/TXT, MAIL FROM).
- **Railway account** (https://railway.app). Create an empty project; no services yet.
- **Stripe live-mode** (https://dashboard.stripe.com). Flip the live toggle; complete any outstanding account verification prompts. Don't create prices or webhook yet.

## 1. DNS setup in GoDaddy

Log into GoDaddy DNS for `erikamiguel.com` and add:

- **Resend records** (3 records — exact values copied from the Resend dashboard). These verify the sending domain.
- **App CNAME** — leave this for Step 3 below; we can't set it yet because Railway hasn't generated its hostname.

## 2. Railway services

1. **Postgres add-on** — click Add → Database → Postgres. It auto-populates `DATABASE_URL` in the shared project env.
2. **Redis add-on** — Add → Database → Redis. Auto-populates `REDIS_URL`.
3. **`web` service** — New Service → GitHub repo → this repo. Settings:
   - Build method: Dockerfile
   - Start command: `node dist/server.js`
   - Pre-deploy: `pnpm --package=drizzle-kit@0.33 dlx drizzle-kit migrate --config=drizzle.config.ts`
   - Port: expose 7777 (or leave Railway's default and use `$PORT`)
4. **`worker` service** — New Service → GitHub repo → same repo. Settings:
   - Build method: Dockerfile (same one)
   - Start command: `node dist/worker.js`
   - No pre-deploy, no exposed port

## 3. Custom domain

1. In the Railway `web` service → Settings → Domains → Add custom domain → `geo.erikamiguel.com`. Railway shows a CNAME target (e.g. `<project-name>.up.railway.app`).
2. In GoDaddy DNS → add CNAME record:
   - Name: `geo`
   - Value: `<project-name>.up.railway.app`
   - TTL: 600
3. Wait for DNS to propagate (usually <10 min). Railway provisions a Let's Encrypt cert within ~5 min of DNS resolving.
4. Verify: `curl https://geo.erikamiguel.com/healthz` returns `{"ok":true,...}`.

## 4. Stripe live-mode config

1. Stripe dashboard → flip to **live mode** (top-right toggle).
2. Products → **New product**:
   - **"GEO Report"**, $19.00 USD, one-time. Copy the price ID (`price_...`) → `STRIPE_PRICE_ID`.
   - **"Credits Pack"**, $29.00 USD, one-time. Copy the price ID → `STRIPE_CREDITS_PRICE_ID`.
3. Developers → Webhooks → Add endpoint:
   - Endpoint URL: `https://geo.erikamiguel.com/billing/webhook`
   - Listen for: `checkout.session.completed`
   - Reveal signing secret (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`
4. Developers → API keys → Secret key (live) → copy → `STRIPE_SECRET_KEY`.

## 5. Shared env vars

In Railway → project → Settings → Variables, set all of these at **project level** (so both `web` and `worker` inherit):

| Var | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `COOKIE_HMAC_KEY` | `<32-char random>` | Generate with `openssl rand -hex 16` |
| `PUBLIC_BASE_URL` | `https://geo.erikamiguel.com` | |
| `TRUSTED_PROXIES` | `<Railway edge CIDRs>` | Look up current values in Railway docs; comma-separated |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | From Anthropic console |
| `OPENAI_API_KEY` | `sk-...` | From OpenAI dashboard |
| `GEMINI_API_KEY` | `AI...` | From Google AI Studio |
| `PERPLEXITY_API_KEY` | `pplx-...` | From Perplexity API settings |
| `OPENROUTER_API_KEY` | `sk-or-...` | Optional but recommended (fallback) |
| `RESEND_API_KEY` | `re_...` | From Resend dashboard (only after domain verified) |
| `MAIL_FROM` | `noreply@send.geo.erikamiguel.com` | Must match Resend's verified domain |
| `STRIPE_SECRET_KEY` | `sk_live_...` | Step 4 |
| `STRIPE_WEBHOOK_SECRET` | `whsec_live_...` | Step 4 |
| `STRIPE_PRICE_ID` | `price_...` | Step 4 (GEO Report $19) |
| `STRIPE_CREDITS_PRICE_ID` | `price_...` | Step 4 (Credits Pack $29) |

`DATABASE_URL` and `REDIS_URL` are auto-set by the add-ons — don't paste manually.

## 6. First deploy

1. Push the feature branch with Plan 10's code to `main` (or whatever branch Railway is tracking).
2. Railway auto-detects the push and starts a build. Watch the "Deployments" tab.
3. The pre-deploy hook runs `drizzle-kit migrate`. If it fails, the new version is NOT promoted — the old (if any) stays live. Check migration output in the Railway logs.
4. Once the build + migration succeed, both services are live.

## 7. Post-deploy smoke test

From your local machine:

```bash
pnpm smoke:prod https://geo.erikamiguel.com
```

Expected output:
```
smoke-prod: target https://geo.erikamiguel.com
✓ /healthz
✓ POST /grades → <uuid>
  grade status: running
  grade status: done
✓ grade done in 43s overall=72
smoke-prod: all checks passed
```

If anything fails, check Railway logs for the failing service and investigate.

## 8. Manual paid-flow smoke (live mode — no test cards)

Stripe live mode doesn't accept `4242 4242 4242 4242`. To smoke the paid flow:

1. Open `https://geo.erikamiguel.com` in a browser.
2. Submit a URL (e.g. your own website). Watch the live grade complete.
3. Click "Get the full report — $19". Inline magic-link form appears.
4. Enter your real email. Check your inbox for the magic link.
5. Click the magic link. You're redirected to `/g/<grade>?verified=1`.
6. Click "Get the full report — $19" again. Stripe Checkout loads.
7. Pay with a real card. Stripe redirects back.
8. Watch the SSE events flip the page to "Report ready". Click "View report" — the HTML report loads.
9. Click "Download PDF". PDF downloads.
10. **Refund**: Stripe dashboard → Payments → find the transaction → Refund. Avoid leaving the $19 sitting in your revenue line.

## 9. Rollback

If the new deploy has an issue:

1. Railway → `web` service → Deployments → click the prior successful deploy → "Redeploy".
2. Same for `worker`.
3. DB schema in Plan 10 is forward-only. If a future plan ships a breaking schema change, this runbook gets a down-migration step.

## 10. Adding a second deploy target (future)

The runbook is idempotent. If you ever redeploy to a second Railway project (staging? eu-region?), copy this file and adjust the subdomain + env values.
```

- [ ] **Step 2: Commit**

```bash
git add docs/deploy-runbook.md
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "docs: add Plan 10 deploy runbook"
```

---

## Self-review checklist (controller runs this)

Before handing off to execution, verify:

**1. Spec coverage:**
- env vars (P10-4/-7/-11) → Task 1 ✓
- Truncate provider errors (P10-13) → Task 2 ✓
- Request log + redaction (P10-9) → Task 3 ✓
- SSRF helper + fetch + render (P10-10) → Tasks 4, 5, 6 ✓
- Trusted-proxy XFF (P10-11) → Task 7 ✓
- /billing/checkout rate limit (P10-12) → Task 8 ✓
- Graceful shutdown (P10-14) → Task 9 ✓
- ResendMailer + factory (P10-4) → Tasks 10, 11 ✓
- .dockerignore + Dockerfile (P10-6) → Tasks 12, 13 ✓
- Smoke script + integration test (P10-16) → Tasks 14, 15 ✓
- Deploy runbook → Task 16 ✓
- Stripe live-mode (P10-15) — no code, only runbook step → Task 16 ✓
- Service topology (P10-7), DB migrations (P10-8) — operational, covered by runbook → Task 16 ✓

**2. Placeholder scan:** grep for `TBD|TODO|similar to|fill in` in the plan — none found. Every step has concrete code.

**3. Type consistency:**
- `BillingRouterDeps.redis` introduced Task 8, used from Task 8 onward.
- `clientIp(opts)` signature changed Task 7; both new and existing tests updated in Task 7 Step 7.
- `CheckoutResult` union extended Task 8; no other consumer.
- `ResendMailer` + `MailerError` defined Task 10, consumed Task 11.
- `buildShutdown` / `ShutdownDeps` introduced Task 9, local to worker.

**4. TDD discipline:** every task with logic writes a failing test first. Pure config tasks (12, 13, 16) verify via `docker build` / `pnpm typecheck` instead of unit tests — appropriate.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-geo-reporter-plan-10-deploy.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance + code quality) between tasks, fast iteration.

**2. Inline Execution** — batch through tasks in this session using executing-plans.

**Which approach?**
