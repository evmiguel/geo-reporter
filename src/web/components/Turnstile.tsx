import React, { useEffect, useRef } from 'react'

/**
 * Cloudflare Turnstile widget wrapper.
 *
 * Loads the Turnstile script once (module-level promise), then renders an
 * invisible challenge. The widget fires `onToken` when it finishes — that
 * token is single-use, valid 300s, and must be submitted to the server for
 * verification. Resets itself on expiry so submits after a long pause still
 * get a fresh token.
 *
 * Dev fallback: if `VITE_TURNSTILE_SITE_KEY` is empty, the component renders
 * nothing and immediately calls `onToken('')`. The server also skips
 * verification when its secret is missing, so `pnpm dev` keeps working.
 *
 * Docs: https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? ''

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: TurnstileRenderOpts) => string
      remove: (widgetId: string) => void
      reset: (widgetId: string) => void
    }
  }
}

interface TurnstileRenderOpts {
  sitekey: string
  callback: (token: string) => void
  'error-callback'?: () => void
  'expired-callback'?: () => void
  size?: 'normal' | 'compact' | 'invisible' | 'flexible'
  appearance?: 'always' | 'execute' | 'interaction-only'
  theme?: 'light' | 'dark' | 'auto'
}

let scriptPromise: Promise<void> | null = null
function loadScript(): Promise<void> {
  if (scriptPromise !== null) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    if (window.turnstile) { resolve(); return }
    const s = document.createElement('script')
    s.src = SCRIPT_SRC
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load Turnstile'))
    document.head.appendChild(s)
  })
  return scriptPromise
}

interface TurnstileProps {
  onToken: (token: string) => void
  /** Reset counter — increment to force a new challenge after a failed submit. */
  resetKey?: number
}

export function Turnstile({ onToken, resetKey = 0 }: TurnstileProps): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)

  useEffect(() => {
    // Dev path — no site key configured. Emit empty token so the submit
    // pipeline doesn't hang waiting for one; the server skips verification.
    if (SITE_KEY.length === 0) {
      onToken('')
      return
    }

    let cancelled = false
    void (async () => {
      await loadScript()
      if (cancelled || !containerRef.current || !window.turnstile) return

      // If we had a previous widget (resetKey bump), clean it up first.
      if (widgetIdRef.current !== null) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        callback: onToken,
        'error-callback': () => onToken(''),
        'expired-callback': () => onToken(''),
        appearance: 'interaction-only', // invisible unless CF flags suspicious
        theme: 'light',
      })
    })()

    return () => {
      cancelled = true
      if (widgetIdRef.current !== null && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current) } catch { /* ignore */ }
        widgetIdRef.current = null
      }
    }
  }, [onToken, resetKey])

  // If no site key, render nothing — dev bypass.
  if (SITE_KEY.length === 0) return null
  return <div ref={containerRef} className="turnstile-widget" />
}
