import React from 'react'
import { Toast } from './Toast.tsx'

interface CheckoutCanceledToastProps {
  onDismiss: () => void
}

export function CheckoutCanceledToast({ onDismiss }: CheckoutCanceledToastProps): JSX.Element {
  return <Toast message="Checkout canceled — no charge." onDismiss={onDismiss} />
}
