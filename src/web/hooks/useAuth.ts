import { useCallback, useEffect, useState } from 'react'
import { getAuthMe, postAuthLogout } from '../lib/api.ts'

export interface AuthState {
  verified: boolean
  email: string | null
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

export function useAuth(): AuthState {
  const [verified, setVerified] = useState<boolean>(false)
  const [email, setEmail] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const me = await getAuthMe()
    setVerified(me.verified)
    setEmail(me.email ?? null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    await postAuthLogout()
    await refresh()
  }, [refresh])

  return { verified, email, refresh, logout }
}
