import React from 'react'
import { Toast } from './Toast.tsx'

interface CreditsPurchasedToastProps {
  kind: 'purchased' | 'canceled'
  onDismiss: () => void
}

export function CreditsPurchasedToast({ kind, onDismiss }: CreditsPurchasedToastProps): JSX.Element {
  const message = kind === 'purchased'
    ? '10 credits added.'
    : 'Checkout canceled — no charge.'
  return <Toast message={message} onDismiss={onDismiss} />
}
