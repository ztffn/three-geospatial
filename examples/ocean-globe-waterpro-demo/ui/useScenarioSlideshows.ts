// Read-only client hook for a scenario's published slideshows: fetches the
// runtime decks for the active scenario from /api/authoring and refetches on
// scenario change. Pure view state — all admin session handling and CRUD
// mutations live in author/ (useAuthorSession, useSlideshowAdmin), which is
// only loaded on the /author route.

import { useCallback, useEffect, useState } from 'react'

import type {
  RuntimeSlideshowDeck,
  ScenarioSlideshowsResponse
} from '../authoring/types'

export async function jsonOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
  }
  if (!response.ok) {
    throw new Error(body.error ?? `request failed (${response.status})`)
  }
  return body as T
}

export interface ScenarioSlideshowsState {
  decks: RuntimeSlideshowDeck[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

// includeDisabled requests the admin view (disabled decks too); the server
// honors it only for an authenticated admin session (cookie), so passing it
// from a visitor context degrades to the published view.
export function useScenarioSlideshows(
  scenarioId: string | null,
  includeDisabled = false
): ScenarioSlideshowsState {
  const [decks, setDecks] = useState<RuntimeSlideshowDeck[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (scenarioId == null) {
      setDecks([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const suffix = includeDisabled ? '?includeDisabled=1' : ''
      const response = await fetch(
        `/api/authoring/scenarios/${encodeURIComponent(
          scenarioId
        )}/slideshows${suffix}`
      )
      const data = await jsonOrThrow<ScenarioSlideshowsResponse>(response)
      setDecks(data.slideshows)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'failed to load slideshows')
    } finally {
      setLoading(false)
    }
  }, [includeDisabled, scenarioId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { decks, loading, error, refresh }
}
