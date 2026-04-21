#!/usr/bin/env tsx
/**
 * Replay the scrape pipeline for a given URL and print exactly what happened.
 * Useful for diagnosing "grade failed" cases where the worker ate the error
 * and we only see status='failed' in the DB.
 *
 * Usage:
 *   pnpm tsx scripts/diagnose-scrape.ts https://americanexpress.com
 *
 * Needs Chromium installed locally for the Playwright fallback:
 *   pnpm exec playwright install chromium
 *
 * Exits cleanly; closes the browser pool on teardown.
 */

import { scrape, shutdownBrowserPool, FetchError } from '../src/scraper/index.ts'
import { fetchHtml } from '../src/scraper/fetch.ts'

function line(label: string, value: string | number | boolean): void {
  console.log(`  ${label.padEnd(18)} ${value}`)
}

async function tryStatic(url: string): Promise<void> {
  console.log('\n── Static fetch (fetchHtml) ────────────────────────────')
  const started = Date.now()
  try {
    const res = await fetchHtml(url, { timeoutMs: 10_000 })
    line('status',     'ok')
    line('finalUrl',   res.finalUrl)
    line('contentType', res.contentType)
    line('html.length', res.html.length)
    line('elapsedMs',  Date.now() - started)
  } catch (err) {
    const e = err as Error & { reason?: string; status?: number }
    line('status',  'error')
    line('name',    e.name)
    line('reason',  e.reason ?? '(none)')
    line('httpStatus', e.status ?? '(none)')
    line('message', e.message)
    line('elapsedMs', Date.now() - started)
  }
}

async function tryFull(url: string): Promise<void> {
  console.log('\n── Full scrape() (static → Playwright fallback) ────────')
  const started = Date.now()
  try {
    const result = await scrape(url, { fetchTimeoutMs: 10_000, renderTimeoutMs: 15_000 })
    line('status',       'ok')
    line('rendered',     result.rendered)
    line('text.length',  result.text.length)
    line('html.length',  result.html.length)
    line('elapsedMs',    Date.now() - started)
    console.log('\n  First 300 chars of text:')
    console.log('  ' + '─'.repeat(60))
    console.log('  ' + result.text.slice(0, 300).replace(/\s+/g, ' '))
    console.log('  ' + '─'.repeat(60))
  } catch (err) {
    const e = err as Error
    line('status',    'error')
    line('name',      e.name)
    line('message',   e.message)
    line('elapsedMs', Date.now() - started)
    if (e instanceof FetchError) {
      line('reason', (e as unknown as { reason: string }).reason)
    }
    if (e.stack) {
      console.log('\nStack:')
      console.log(e.stack.split('\n').slice(0, 8).map((l) => '  ' + l).join('\n'))
    }
  }
}

async function main(): Promise<void> {
  const url = process.argv[2]
  if (!url) {
    console.error('Usage: diagnose-scrape.ts <url>')
    process.exit(1)
  }
  try {
    new URL(url)
  } catch {
    console.error(`Invalid URL: ${url}`)
    process.exit(1)
  }

  console.log(`Target: ${url}`)

  await tryStatic(url)
  await tryFull(url)

  await shutdownBrowserPool()
  process.exit(0)
}

main().catch((err) => {
  console.error('diagnose-scrape crashed:', err)
  shutdownBrowserPool().finally(() => process.exit(1))
})
