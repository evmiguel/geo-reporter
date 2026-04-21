import type { SitemapStatus, LlmsTxtStatus } from './types.ts'
import { safeFetch, type SafeFetchDeps } from './safe-fetch.ts'

const TIMEOUT_MS = 5_000

function originOf(inputUrl: string): string {
  const u = new URL(inputUrl)
  return `${u.protocol}//${u.host}`
}

async function headOrGetStatus(
  url: string,
  deps: SafeFetchDeps,
): Promise<{ ok: boolean; body: string | null }> {
  try {
    const res = await safeFetch(url, { timeoutMs: TIMEOUT_MS }, deps)
    if (!res.ok) return { ok: false, body: null }
    const body = await res.text()
    return { ok: true, body }
  } catch {
    // Network errors and SSRF blocks both yield "discovery doc absent" — same
    // as a 404. Probing `/robots.txt` against a private IP is exactly the
    // bypass we're closing, so failing closed is the right default.
    return { ok: false, body: null }
  }
}

export async function fetchRobotsTxt(inputUrl: string, deps: SafeFetchDeps = {}): Promise<string | null> {
  const url = `${originOf(inputUrl)}/robots.txt`
  const r = await headOrGetStatus(url, deps)
  return r.ok ? r.body : null
}

export async function fetchSitemapStatus(inputUrl: string, deps: SafeFetchDeps = {}): Promise<SitemapStatus> {
  const url = `${originOf(inputUrl)}/sitemap.xml`
  const r = await headOrGetStatus(url, deps)
  return { present: r.ok, url }
}

export async function fetchLlmsTxtStatus(inputUrl: string, deps: SafeFetchDeps = {}): Promise<LlmsTxtStatus> {
  const url = `${originOf(inputUrl)}/llms.txt`
  const r = await headOrGetStatus(url, deps)
  return { present: r.ok, url }
}
