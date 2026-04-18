# Production Readiness Checklist

Living document of items deferred from plan execution that must be resolved before shipping to real users. Add new items as they're deferred; check them off in dedicated hardening plans or as part of Plan 10 (deploy).

---

## Security

- [ ] **SSRF defense with DNS-lookup-time resolution check.** Plan 6a intentionally ships the minimum (scheme check only — `http:` / `https:`). Before ship, implement the full defense: resolve the target hostname, check each A/AAAA record against RFC 1918, loopback, link-local, and cloud-metadata ranges (169.254.169.254, fd00::, etc.); reject if any match. Must pin the resolved IP into the outgoing fetch so DNS rebinding can't swap during the connection. `undici`'s `Dispatcher` interception or `node:dns.lookup` + explicit-socket in `fetch` are two paths. Deferred per Plan 6a brainstorm Q4 — reason: platform-level egress rules (Railway/Fly) block internal access at the network layer in prod, which is where SSRF defense actually belongs. But we should NOT rely on platform rules alone — a layered defense is mandatory.
- [ ] **Cookie signing (HMAC) for anonymous tracker.** Plan 6a ships plain UUID v4 cookies. A tampered cookie can only redirect someone else's rate-limit bucket — low-impact — but before wider launch, add HMAC-signed cookies (Plan 7 will introduce session cookies; unify at that point). Sub-spec Plan 6a Q1.
- [ ] **Rate-limit atomicity.** Current design does separate Redis ZCARD → ZADD. Under concurrent POST /grades from the same cookie, a race window allows slight overage (e.g. 4 grades when the limit is 3). Fix with a single Lua script: `ZREMRANGEBYSCORE` + `ZCARD` + conditional `ZADD`, returning "allowed" or "denied" atomically. Plan 6a brainstorm noted this as out-of-scope-for-MVP.
- [ ] **Trusted-proxy allow-list for IP detection.** Plan 6a trusts `X-Forwarded-For` unconditionally when present. A malicious client can spoof XFF to evade rate limits. Before ship, introduce `TRUSTED_PROXIES` config; only accept XFF from those addresses. On Railway this is usually the Envoy proxy's internal IP range.
- [ ] **No secrets in logs.** Audit all worker/server log lines for accidental inclusion of API keys, session cookies, or DB URLs. Hono's default logger is safe; provider clients may log request bodies on error (e.g. the ProviderError message includes the 4xx/5xx body — which might echo the API key back). Grep + integration test.

## Reliability / ops

- [ ] **Observability: OTel tracing + structured metrics.** Plan 5 left this explicitly for Plan 10. Minimum: request-level trace spans on the Hono server, per-job trace spans on BullMQ workers, per-LLM-call child spans with provider ID and token counts. Export to whatever Railway offers (Honeycomb/Datadog/etc.). Deferred per Plan 5 sub-spec §12.
- [ ] **Per-provider rate-limit queues / backpressure.** Currently, if Anthropic starts 429ing, BullMQ retries with exponential backoff and eventually fails soft. Under steady load that means we'll be bursting past provider quotas. Before ship, add per-provider token-bucket limiters around `provider.query()` — pacing the whole worker pool to the slowest provider's limit. Plan 5 deferred.
- [ ] **Cancel / abort a running grade.** Users can't currently cancel an in-flight grade. If they close the tab, the worker keeps spending tokens. Add a cancel endpoint (`POST /grades/:id/cancel` → sets an `abort` key in Redis; worker's AbortSignal wiring already threads through Plan 4's flow functions to pick it up). Plan 5 out-of-scope.
- [ ] **Testcontainers flake in CI.** CLAUDE.md notes an occasional first-run race where BullMQ's Redis connects before the container is fully ready, retries once, succeeds. Tolerable locally; before CI scales up, either add a readiness-wait in `tests/integration/setup.ts` or bake `enableReadyCheck: false` into the test harness. Already documented in CLAUDE.md footguns.
- [ ] **Playwright pool scaling under load.** Plan 2's Chromium pool caps at 2 concurrent pages with a 15s render timeout. Under Railway's default CPU allocation, two concurrent grades exhausting the pool will serialize new grades. Before ship, benchmark pool-vs-concurrency and either raise the cap or add a queue-depth metric + autoscale signal.
- [ ] **Worker graceful shutdown drains jobs.** Current SIGTERM handler closes workers but doesn't wait for in-flight jobs. If Railway sends SIGTERM during a deploy, a grade mid-flight dies. BullMQ's `worker.close(true)` waits for the active job; audit `src/worker/worker.ts` to ensure we pass the drain flag.

## Data / correctness

- [ ] **Cost tracking (dollars).** Plan 4 Q6 deliberately dropped `costUsd` from the `QueryResult` to avoid a drifting price table. Token counts are preserved. Before ship, decide: either add a single cost-lookup endpoint (read-time, e.g. `/admin/costs?gradeId=X`) that computes from token counts + current prices, OR skip entirely and let the business side reconcile via Stripe + provider bills. Revenue math depends on this.
- [ ] **DNS rebinding defense.** See SSRF item above — the IP-pinned fetch is the same mechanism.
- [ ] **Real-provider smoke test in CI.** Plan 4/5 ship with MockProvider only; no real-API test ever runs. Before ship, add one CI job gated on `REAL_PROVIDERS=1` that grades a known-stable fixture URL (e.g. example.com or a self-hosted test server) against the 4 real providers. Should be a pre-deploy gate, not a per-PR check.
- [ ] **Integration with actual Playwright sysdeps on CI image.** WSL2 dev machines need `libnspr4 libnss3 libasound2t64` (per CLAUDE.md + README). CI's Docker image may or may not have these. Add to the container build once Plan 10 (deploy) lands.

## UX / product

- [ ] **SSE client hydration stress test.** Plan 6a ships "always hydrate on connect" — SELECT probes + scrape + grade row, synthesize past events, then subscribe. For a grade with 39 probes (paid tier), that's 41 synthesized events fired in quick succession. Verify the frontend (Plan 6b) doesn't drop frames or over-render; batch synthesized events into one frame if needed.
- [ ] **Error page polish.** Plan 6a returns `429 { paywall, limit, used, retryAfter }` on rate-limit hit. Plan 6b's frontend must render this with a human-readable wait time and a clear "verify your email for 10 more grades" CTA. UX copy not yet drafted.

---

## Policy

- Add items here when you defer them during planning or execution. Don't let deferred decisions get lost in commit messages or brainstorm transcripts.
- Each item should say: **what it is**, **why it was deferred**, and **what to do before shipping**. Vague todos ("make SSL work") are not checklist items.
- Check off items in the commit that implements them and reference the commit hash here (optional but nice).
- Plan 10 (deploy) should treat this as a pre-flight checklist: nothing ships to public URL until the security section is green.
