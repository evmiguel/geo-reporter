import React from 'react'

interface SpinnerProps {
  size?: number
  className?: string
}

/**
 * Small inline spinner for pending button states. Paired with text labels
 * (aria-hidden=true so screen readers read only the label), sized to align
 * with the button's x-height.
 */
export function Spinner({ size = 12, className = '' }: SpinnerProps): JSX.Element {
  return (
    <svg
      className={`animate-spin inline-block ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="15 50"
      />
    </svg>
  )
}
