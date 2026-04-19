import React from 'react'

interface CreditBadgeProps {
  credits: number
}

export function CreditBadge({ credits }: CreditBadgeProps): JSX.Element {
  return (
    <span
      data-testid="credit-badge"
      title={`${credits} credit${credits === 1 ? '' : 's'} available`}
      className="bg-[var(--color-good)] text-[var(--color-bg)] px-2 py-0.5 text-xs rounded font-semibold"
    >
      {credits} {credits === 1 ? 'credit' : 'credits'}
    </span>
  )
}
