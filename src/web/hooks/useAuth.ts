import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
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

const AuthContext = createContext<AuthState | null>(null)

/**
 * Wraps the app so every useAuth() call reads the same shared state.
 * Without a provider, each useAuth() instance has its own useState — clicking
 * logout in the Header updates only the Header's state while AccountPage
 * keeps thinking you're signed in (and vice versa).
 */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
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

  const value: AuthState = { verified, email, credits, loading, refresh, logout }
  return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return ctx
}
