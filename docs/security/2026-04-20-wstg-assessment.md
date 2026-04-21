# WSTG Security Assessment — `georeport.erikamiguel.com`

**Mode:** Gray box (source + live)
**Date:** 2026-04-20
**Methodology:** OWASP WSTG v4.2
**Stack:** Node 20 + Hono + BullMQ + Playwright on Railway behind Fastly

---

## Summary

Baseline is solid — Turnstile enforced server-side, magic-link tokens SHA-256 hashed and cookie-bound, cookies HMAC-signed with `HttpOnly` / `Secure` / `SameSite=Lax`, Stripe webhook signature verification, TLS 1.0/1.1 disabled, `GradeStore` seam and `isOwnedBy` applied consistently, report tokens use `timingSafeEqual`.

Findings cluster in three areas:

1. **Scraper fetch chain has SSRF bypass via redirect-follow + TOCTOU** (highest impact)
2. **Missing HTTP security headers** on the SPA
3. **Defense-in-depth gaps** (cookie grace path, rate-limit design, container runs as root)

Nothing unauthenticated-RCE / account-takeover-class found.

---

## Findings

| # | Sev | Title | WSTG | CWE |
|---|-----|-------|------|-----|
| F-1 | HIGH | SSRF via redirect-follow + TOCTOU in scraper | INPV-11 | 918 |
| F-2 | MED | Plaintext UUID cookie grace path | SESS-02 | 384 |
| F-3 | MED | Verified users bypass the anon-IP ceiling | BUSL-05 | 799 |
| F-4 | MED | Missing HTTP security headers | CONF-07 | 693 |
| F-5 | LOW | Open-redirect via backslash in `next` | CLNT-04 | 601 |
| F-6 | LOW | `/healthz` exposes DB/Redis state | CONF-02 | 200 |
| F-7 | LOW | Container runs as root, Chromium `--no-sandbox` | CONF-04 | 250 |
| F-8 | LOW | Zod errors leak schema details | ERRH-01 | 209 |
| F-9 | INFO | SSE connections per-subscriber unbounded | — | 400 |
| F-10 | INFO | Host fingerprinting via Railway/Fastly headers | INFO-08 | 200 |

---

### 🔴 F-1 HIGH — SSRF via redirect-follow + TOCTOU in scraper

**Files:** `src/scraper/fetch.ts:40-71`, `src/scraper/render.ts:114-131`, `src/scraper/discovery.ts:10-41`, `src/scraper/index.ts:62-66`

`resolveSafeHost()` runs once on the *original* hostname, then `fetch(url, { redirect: 'follow' })` is issued separately. Two bypass paths:

1. **Redirect bypass** — a public attacker domain (passes DNS check) responds `302 Location: http://10.0.0.5/`. `fetch`'s built-in redirect follower never re-enters the SSRF guard. `finalUrl` becomes the internal URL, then `discovery.ts` (which has **no SSRF guard at all**) fetches `/robots.txt`, `/sitemap.xml`, `/llms.txt` against it. Playwright's `page.goto()` follows redirects internally with the same problem.
2. **DNS rebinding** — a low-TTL attacker domain returns a public IP to `resolveSafeHost` and an internal IP to the subsequent `fetch`.

**Impact on Railway:** GCP metadata requires `Metadata-Flavor: Google`, so cloud-creds theft doesn't trivially work — but internal Railway mesh IPs, sidecar containers, and any localhost-bound admin surfaces inside the container are reachable. Blind SSRF at minimum; `render.ts` (Playwright) has no content-type filter and `discovery.ts` reads `.text()` unconditionally.

**Conceptual PoC:**
```
attacker.com → 302 http://127.0.0.1:8080/
POST /grades { url: "https://attacker.com/", turnstileToken: <valid> }
→ worker fetches attacker.com → follows redirect to 127.0.0.1:8080
→ discovery fetches http://127.0.0.1:8080/robots.txt (no guard)
```

**Fix:** see Patch F-1 below.

---

### 🟠 F-2 MED — Plaintext UUID cookie grace path allows session hijacking if UUID leaks

**Files:** `src/server/middleware/cookie.ts:65-76`, `src/server/middleware/cookie-sign.ts:31-41`

`parseCookie()` still accepts a bare UUID as a valid `ggcookie` (`{ kind: 'plain' }`) as a migration grace path. If any user's cookie UUID is disclosed — via logs, error messages, DOM leak, or a future info-disclosure bug — an attacker can send that UUID verbatim with no HMAC and the server will accept it, `upsertCookie` it, re-sign it, and bind the attacker's session to the victim's userId (if bound).

**Impact:** Session takeover preconditioned on UUID leak. Low standalone, force-multiplier for any other disclosure bug.

**Fix:** see Patch F-2 below.

---

### 🟠 F-3 MED — Verified users bypass the anon-IP ceiling

**File:** `src/server/middleware/rate-limit.ts:56-63`, `:78-82`

The 5/day/IP anon ceiling only applies when `userId === null`. Anyone who verifies a single email gets 10 grades/day *per cookie* with zero per-IP cap. Free magic-link issuance is only rate-limited at 1 email/min and 5 emails/10-min/IP, so an attacker with a handful of disposable inboxes can verify, rotate cookies, and get unbounded grades from one IP.

**Impact:** Amplified LLM / Playwright cost abuse. Each grade runs real provider calls — direct $$ hit.

**Fix:** see Patch F-3 below.

---

### 🟠 F-4 MED — Missing HTTP security headers

**Observed on:** `GET /` (the SPA)

Missing:

- `Strict-Transport-Security` — first-visit MitM can strip TLS
- `Content-Security-Policy` — XSS mitigations absent (defense-in-depth)
- `X-Frame-Options: DENY` / `CSP frame-ancestors 'none'` — clickjacking viable
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy: same-origin`

`/report/:id` *does* set CSP correctly — just the main app and API routes don't.

**Fix:** see Patch F-4 below.

---

### 🟡 F-5 LOW — Possible open-redirect via backslash in `next`

**File:** `src/server/routes/auth.ts:37` (regex `/^\/(?:$|[^/])/`)

Regex rejects `//evil.com` but accepts `/\evil.com`. Chromium/Firefox have historically normalized leading `/\` to `//` during `Location` parsing, producing an open redirect.

**Preconditions:** attacker must trigger the victim's magic-link email with an attacker-supplied `next` — not a standalone attack, but a phishing-chain tail.

**Fix:** see Patch F-5 below.

---

### 🟡 F-6 LOW — `/healthz` exposes DB/Redis state unauthenticated

`GET /healthz` → `{"ok":true,"db":true,"redis":true}`. Timing oracle for when the backend is stressed (chain with rate-limit flood or webhook replay under load).

**Fix:** see Patch F-6 below.

---

### 🟡 F-7 LOW — Container runs as root, Chromium with `--no-sandbox`

**Files:** `Dockerfile` (no `USER` directive), `src/scraper/render.ts:27`

No `USER` in the runtime stage, Playwright launches Chromium with `--no-sandbox`. If the render stage hits a Chromium renderer bug on a malicious target page, it's root-in-container with no sandboxing. Railway's container boundary is the only defense.

**Fix:** see Patch F-7 below. `--no-sandbox` stays (Railway won't grant `SYS_ADMIN`); non-root user narrows blast radius.

---

### 🟡 F-8 LOW — Zod errors leak schema details

`POST /grades` with empty body returns full ZodError JSON (`code`, `path`, `expected`). Helps an attacker map the schema.

**Fix:** see Patch F-8 below.

---

### ℹ️ F-9 INFO — SSE connections are per-subscriber unbounded

**File:** `src/server/routes/grades-events.ts:96-114`

Each `/grades/:id/events` spawns a Redis subscriber + holds a DB pool slot. No per-cookie cap. Authenticated user with one grade can open many streams — bounded by their network but can exhaust server connection budget.

**Fix:** see Patch F-9 below.

---

### ℹ️ F-10 INFO — Host fingerprinting via Railway/Fastly headers

`server: railway-edge`, `x-railway-request-id`, `x-railway-edge`, `x-railway-cdn-edge`, `x-served-by` — tells an attacker the infra stack. Can strip with a Hono middleware if desired, but mostly added by Fastly/Railway so not fully hideable.

---

## Patches

Priority order. Suggested commit plan at the end.

---

### Patch F-1 — SSRF hardening: per-hop validation + connect-time DNS check

Three layers of defense so it survives both redirect chains and DNS rebinding.

#### New file: `src/scraper/safe-fetch.ts`

```ts
import { Agent, fetch as undiciFetch } from 'undici'
import { lookup } from 'node:dns'
import { resolveSafeHost, isPrivateAddress, SSRFBlockedError } from './ssrf.ts'

// undici Agent whose socket-level DNS lookup rejects private IPs. This is the
// ONLY layer that survives DNS rebinding: resolve-then-fetch TOCTOU races
// can't beat this because the lookup happens at connect time, and the IP
// that's validated is the IP we connect to.
const safeAgent = new Agent({
  connect: {
    lookup(hostname, options, cb) {
      lookup(hostname, { all: true, ...options }, (err, addrs) => {
        if (err) { cb(err, '', 0); return }
        const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }]
        for (const a of list) {
          if (isPrivateAddress(a.address)) {
            cb(new SSRFBlockedError(hostname, a.address), '', 0)
            return
          }
        }
        const pick = list[0]!
        cb(null, pick.address, pick.family)
      })
    },
  },
})

export interface SafeFetchOptions {
  timeoutMs?: number
  maxRedirects?: number
  headers?: Record<string, string>
  method?: string
}

/**
 * fetch() wrapper that:
 *  - validates hostname before every hop (catches obvious public→private redirects),
 *  - routes all connections through safeAgent (catches DNS rebinding), and
 *  - follows redirects manually with a hard cap.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5
  const timeoutMs = opts.timeoutMs ?? 10_000
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let current = url
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = new URL(current)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SSRFBlockedError(parsed.hostname, `bad-protocol:${parsed.protocol}`)
      }
      await resolveSafeHost(parsed.hostname)

      const res = await undiciFetch(current, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: safeAgent,
      })

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return res
        current = new URL(loc, current).toString()
        continue
      }
      return res
    }
    throw new Error('too many redirects')
  } finally {
    clearTimeout(t)
  }
}
```

#### Patch `src/scraper/fetch.ts`

```ts
import { safeFetch } from './safe-fetch.ts'

export async function fetchHtml(url: string, opts: FetchHtmlOptions = {}): Promise<FetchHtmlResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ua = opts.userAgent ?? DEFAULT_UA
  let res: Response
  try {
    res = await safeFetch(url, {
      timeoutMs,
      headers: { 'user-agent': ua, accept: 'text/html,*/*;q=0.8' },
    })
  } catch (err) {
    if ((err as Error).name === 'SSRFBlockedError') {
      throw new FetchError(`ssrf: ${(err as Error).message}`, 'network')
    }
    if ((err as Error).name === 'AbortError') {
      throw new FetchError(`fetch timed out after ${timeoutMs}ms`, 'timeout')
    }
    throw new FetchError(`network error: ${(err as Error).message}`, 'network')
  }
  // ... rest unchanged (content-type check, text() read)
}
```

Drop the `if (process.env.NODE_ENV === 'production')` wrapper — guard should run in dev too.

#### Patch `src/scraper/discovery.ts`

```ts
import { safeFetch } from './safe-fetch.ts'

async function headOrGetStatus(url: string): Promise<{ ok: boolean; body: string | null }> {
  try {
    const res = await safeFetch(url, { timeoutMs: TIMEOUT_MS })
    if (!res.ok) return { ok: false, body: null }
    return { ok: true, body: await res.text() }
  } catch {
    return { ok: false, body: null }
  }
}
// rest of the file unchanged
```

#### Patch `src/scraper/render.ts`

```ts
// In ensureBrowser(), after creating context:
this.context = await this.browser.newContext({ /* ... */ })
await this.context.route('**/*', async (route) => {
  const reqUrl = route.request().url()
  try {
    const parsed = new URL(reqUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      await route.abort('blockedbyclient')
      return
    }
    await resolveSafeHost(parsed.hostname)
    await route.continue()
  } catch {
    await route.abort('blockedbyclient')
  }
})
```

**Caveat:** Chromium does its own DNS. `route` intercepts pre-send with the post-redirect URL, so each hop is validated. Sliver of TOCTOU remains for Chromium's internal DNS cache — acceptable in practice.

---

### Patch F-2 — Delete the plaintext cookie grace path

#### `src/server/middleware/cookie-sign.ts`

```ts
// Remove the UUID_V4_REGEX plain-cookie branch:
export function parseCookie(raw: string): ParsedCookie {
  if (!raw) return { kind: 'malformed' }
  const parts = raw.split('.')
  if (parts.length !== 2) return { kind: 'malformed' }
  const [uuid, hmac] = parts
  if (!uuid || !hmac || !UUID_V4_REGEX.test(uuid) || hmac.length !== HMAC_CHARS) {
    return { kind: 'malformed' }
  }
  return { kind: 'signed', uuid, hmac }
}
// Also remove `plain` from the ParsedCookie union type.
```

#### `src/server/middleware/cookie.ts`

Delete the entire `if (parsed.kind === 'plain') { ... }` block in `cookieMiddleware`. The existing `else`-branch issues a fresh cookie for malformed input.

Any user still on a plain cookie gets re-issued a fresh one on their next request — no user-visible breakage.

---

### Patch F-3 — Per-IP cap for verified users

#### `src/server/middleware/rate-limit.ts`

```ts
const VERIFIED_IP_CEILING = 20  // above anon (5), below infinite

export function verifiedIpBucketKey(ip: string): string {
  return `bucket:ip-verified:${ip}`
}

// In peekRateLimit, after the isAnonymous block:
if (!isAnonymous) {
  const ipCfg = { key: verifiedIpBucketKey(ip), limit: VERIFIED_IP_CEILING, windowMs: WINDOW_MS }
  const ipPeek = await peekBucket(redis, ipCfg, now)
  if (!ipPeek.allowed) {
    return { ...ipPeek, paywall: 'ip_exhausted' }
  }
}

// In commitRateLimit, after the anonymous-branch add:
if (!isAnonymous) {
  const ipCfg = { key: verifiedIpBucketKey(ip), limit: VERIFIED_IP_CEILING, windowMs: WINDOW_MS }
  await addToBucket(redis, ipCfg, now, gradeBucketMember(gradeId))
}

// In refundRateLimit, add the verified bucket:
await removeFromBucket(redis, { key: verifiedIpBucketKey(ip) }, member)
```

---

### Patch F-4 — Security headers

#### `src/server/app.ts`

```ts
import { secureHeaders } from 'hono/secure-headers'

// Right after requestLog():
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
    frameSrc: ['https://challenges.cloudflare.com'],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  },
  strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
  xContentTypeOptions: 'nosniff',
  xFrameOptions: 'DENY',
  referrerPolicy: 'strict-origin-when-cross-origin',
  crossOriginOpenerPolicy: 'same-origin',
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    interestCohort: [],
  },
}))
```

**Test first:** turn on in staging, check Turnstile + Stripe checkout redirect still work. If Stripe's redirect gets blocked, add `checkout.stripe.com` to `formAction`.

---

### Patch F-5 — Tighter `next` regex

#### `src/server/routes/auth.ts`

```ts
// Old: const NEXT_PATH_RE = /^\/(?:$|[^/])/
// New — rejects both / and \ at position 1:
const NEXT_PATH_RE = /^\/(?:$|[^/\\])/
```

One character change. Closes the `/\evil.com` → `//evil.com` browser-normalization bypass.

---

### Patch F-6 — Split healthz into public + private

#### `src/server/app.ts`

```ts
// Public: Railway's healthcheck only needs a 200.
app.get('/healthz', (c) => c.json({ ok: true }))

// Private: real dependency status. Behind a shared secret.
app.get('/healthz/deep', async (c) => {
  const token = c.req.header('x-health-token')
  if (!deps.env.HEALTH_TOKEN || token !== deps.env.HEALTH_TOKEN) {
    return c.json({ error: 'forbidden' }, 403)
  }
  const [dbResult, redisResult] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()])
  const db = dbResult.status === 'fulfilled' && dbResult.value === true
  const redis = redisResult.status === 'fulfilled' && redisResult.value === true
  const ok = db && redis
  return c.json({ ok, db, redis }, ok ? 200 : 503)
})
```

Add `HEALTH_TOKEN` to `src/config/env.ts` as optional. Generate a long random string for Railway.

---

### Patch F-7 — Run container as non-root

#### `Dockerfile` (runtime stage)

```dockerfile
# Before CMD:
RUN useradd --system --create-home --uid 1001 --shell /bin/false app \
 && mkdir -p /home/app/.cache \
 && cp -r /root/.cache/ms-playwright /home/app/.cache/ 2>/dev/null || true \
 && chown -R app:app /app /home/app
USER app

CMD ["node", "dist/server.js"]
```

Playwright's browser cache needs to move to the `app` home. Alternative: install Playwright *after* the `USER app` switch (slower build cache).

---

### Patch F-8 — Normalize Zod error responses

#### `src/server/routes/grades.ts`

```ts
app.post(
  '/',
  zValidator('json', CreateGradeBody, (result, c) => {
    if (!result.success) return c.json({ error: 'invalid_body' }, 400)
  }),
  async (c) => {
    // existing handler
  },
)
```

Apply the same pattern to any other `zValidator` without an error hook. `auth.ts` already does it — just port it.

---

### Patch F-9 — Cap concurrent SSE per cookie

#### `src/server/routes/grades-events.ts`

```ts
const MAX_CONCURRENT_SSE = 3
const SSE_COUNTER_TTL_SEC = 3600  // safety net if decrement is lost

// Before streamSSE(...):
const sseKey = `sse:cookie:${c.var.cookie}`
const active = await deps.redis.incr(sseKey)
if (active === 1) await deps.redis.expire(sseKey, SSE_COUNTER_TTL_SEC)
if (active > MAX_CONCURRENT_SSE) {
  await deps.redis.decr(sseKey)
  return c.json({ error: 'too_many_streams' }, 429)
}

return streamSSE(c, async (stream) => {
  try {
    // existing handler body
  } finally {
    await deps.redis.decr(sseKey)
  }
})
```

TTL is belt-and-suspenders in case a crashed worker leaves the counter stuck.

---

## Suggested commit plan

Five separate commits so review is clean:

1. `fix(scraper): SSRF-safe fetch with per-hop + connect-time validation` — F-1
2. `feat(server): add security headers + split healthz` — F-4, F-6
3. `fix(auth): block plain-UUID cookies, tighten next regex` — F-2, F-5
4. `fix(rate-limit): cap verified users per IP, cap SSE per cookie` — F-3, F-9
5. `chore(docker): run container as non-root, normalize zod errors` — F-7, F-8

---

## What I did NOT test

- **Live SSRF PoC** — blocked by Turnstile; confirmed by code review.
- **Rate-limit exhaustion** — didn't want to burn provider credits.
- **Stripe checkout** — didn't create a real session; webhook signature check looks correct in code.
- **Magic-link end-to-end** — didn't generate a real token.
- **XFF rate-limit bypass** — response parity with/without XFF suggests Railway rewrites, but couldn't confirm without a second source IP. Worth verifying from a mobile hotspot that `entries.at(-1)` assumption holds end-to-end through Fastly + Railway.
