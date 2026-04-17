import type { SitemapStatus, LlmsTxtStatus } from './types.ts'

const TIMEOUT_MS = 5_000

function originOf(inputUrl: string): string {
  const u = new URL(inputUrl)
  return `${u.protocol}//${u.host}`
}

async function headOrGetStatus(url: string): Promise<{ ok: boolean; body: string | null }> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    clearTimeout(t)
    if (!res.ok) return { ok: false, body: null }
    const body = await res.text()
    return { ok: true, body }
  } catch {
    clearTimeout(t)
    return { ok: false, body: null }
  }
}

export async function fetchRobotsTxt(inputUrl: string): Promise<string | null> {
  const url = `${originOf(inputUrl)}/robots.txt`
  const r = await headOrGetStatus(url)
  return r.ok ? r.body : null
}

export async function fetchSitemapStatus(inputUrl: string): Promise<SitemapStatus> {
  const url = `${originOf(inputUrl)}/sitemap.xml`
  const r = await headOrGetStatus(url)
  return { present: r.ok, url }
}

export async function fetchLlmsTxtStatus(inputUrl: string): Promise<LlmsTxtStatus> {
  const url = `${originOf(inputUrl)}/llms.txt`
  const r = await headOrGetStatus(url)
  return { present: r.ok, url }
}
