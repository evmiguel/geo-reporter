import { useCallback, useEffect, useState } from 'react'
import { getAuthMe, postAuthLogout } from '../lib/api.ts'

export interface AuthState {
  verified: boolean
  email: string | null
  credits: number
  /**
   * True until the first /auth/me round-trip completes. Gate any
   * redirect-on-unverified guards on this so we don't bounce users out
   * during the initial fetch.
   */
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

export function useAuth(): AuthState {
  const [verified, setVerified] = useState<boolean>(false)
  const [email, setEmail] = useState<string | null>(null)
  const [credits, setCredits] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(true)

  const refresh = useCallback(async () => {
    try {
      const me = await getAuthMe()
      setVerified(me.verified)
      setEmail(me.email ?? null)
      setCredits(me.credits ?? 0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const logout = useCallback(async () => {
    await postAuthLogout()
    await refresh()
  }, [refresh])

  return { verified, email, credits, loading, refresh, logout }
}
