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
