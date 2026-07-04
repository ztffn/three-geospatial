// Author-mode session hook (login/logout): checks/opens/closes the HMAC
// cookie session that authoring/api.ts issues against TWIN_ADMIN_TOKEN. The
// login(token) shape is deliberately auth-provider-ready — a real identity
// provider can replace the token exchange without touching consumers. In dev
// with no TWIN_ADMIN_TOKEN configured, the server reports the session as
// open, so the gate passes through.

import { useCallback, useEffect, useState } from 'react'

import { jsonOrThrow } from '../ui/useScenarioSlideshows'

export interface AuthorSessionState {
  checking: boolean
  authenticated: boolean
  error: string | null
  login: (token: string) => Promise<void>
  logout: () => Promise<void>
}

export function useAuthorSession(): AuthorSessionState {
  const [checking, setChecking] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/authoring/admin/session')
        const data = await jsonOrThrow<{ ok: boolean }>(response)
        if (!cancelled) setAuthenticated(data.ok)
      } catch {
        if (!cancelled) setAuthenticated(false)
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (token: string) => {
    setError(null)
    setChecking(true)
    try {
      await jsonOrThrow<{ ok: boolean }>(
        await fetch('/api/authoring/admin/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token })
        })
      )
      setAuthenticated(true)
    } catch (err: unknown) {
      setAuthenticated(false)
      setError(err instanceof Error ? err.message : 'login failed')
    } finally {
      setChecking(false)
    }
  }, [])

  const logout = useCallback(async () => {
    setError(null)
    setChecking(true)
    try {
      await fetch('/api/authoring/admin/session', { method: 'DELETE' })
    } finally {
      setAuthenticated(false)
      setChecking(false)
    }
  }, [])

  return { checking, authenticated, error, login, logout }
}
