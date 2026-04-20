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
  const start = Date.now()
  let last = 'queued'
  while (Date.now() - start < TIMEOUT_MS) {
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
      console.log(`✓ grade done in ${Math.round((Date.now() - start) / 1000)}s overall=${b.overall}`)
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
