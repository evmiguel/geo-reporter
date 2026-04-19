import React, { useEffect } from 'react'

interface ToastProps {
  message: string
  durationMs?: number
  onDismiss: () => void
}

export function Toast({ message, durationMs = 5000, onDismiss }: ToastProps): JSX.Element {
  useEffect(() => {
    const handle = setTimeout(onDismiss, durationMs)
    return () => clearTimeout(handle)
  }, [message, durationMs, onDismiss])

  return (
    <div
      role="status"
      className="fixed bottom-6 right-6 bg-[var(--color-bg-elevated)] border border-[var(--color-good)] text-[var(--color-fg)] px-4 py-3 text-sm"
    >
      {message}
    </div>
  )
}
