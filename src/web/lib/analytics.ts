/**
 * Thin wrapper around Plausible's `window.plausible(name, { props })`.
 * Keeps event names and property shapes in one place so the analytics
 * taxonomy doesn't drift across components.
 *
 * Plausible auto-tracks pageviews; this is only for custom events.
 * Safe to call before the Plausible script loads — index.html stubs
 * window.plausible into a queue that flushes on script ready.
 *
 * Dev fallback: when Plausible isn't on the window (SSR, tests, or
 * the script blocked), this is a no-op.
 */

type PlausibleFn = (event: string, opts?: { props?: Record<string, string | number | boolean> }) => void

declare global {
  interface Window {
    plausible?: PlausibleFn
  }
}

export type AnalyticsEvent =
  // Landing flow
  | { name: 'grade_submit' }
  | { name: 'grade_submit_credit' }
  // Paid conversion
  | { name: 'checkout_start' }
  | { name: 'credits_buy_start' }
  | { name: 'credit_redeem_existing_grade' }
  // Auth
  | { name: 'email_magic_requested' }
  | { name: 'email_magic_verified' }
  // Diagnostic
  | { name: 'grade_failed'; props: { kind: 'scrape_failed' | 'provider_outage' | 'other' } }

export function track(event: AnalyticsEvent): void {
  if (typeof window === 'undefined') return
  const plausible = window.plausible
  if (!plausible) return
  const name = event.name
  const opts = 'props' in event ? { props: event.props as Record<string, string | number | boolean> } : undefined
  try {
    plausible(name, opts)
  } catch {
    // Never let analytics break the UI — swallow any runtime error from
    // the stubbed queue or the real Plausible script.
  }
}
