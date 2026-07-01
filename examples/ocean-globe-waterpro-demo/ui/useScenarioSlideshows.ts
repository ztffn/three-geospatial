import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  RuntimeSlideshowDeck,
  ScenarioSlideshowsResponse
} from '../authoring/types'

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
  }
  if (!response.ok) {
    throw new Error(body.error ?? `request failed (${response.status})`)
  }
  return body as T
}

function authHeaders(token: string): HeadersInit {
  return token.length > 0 ? { Authorization: `Bearer ${token}` } : {}
}

export interface ScenarioSlideshowsState {
  decks: RuntimeSlideshowDeck[]
  loading: boolean
  error: string | null
  adminOpen: boolean
  adminToken: string
  setAdminOpen: (open: boolean) => void
  setAdminToken: (token: string) => void
  refresh: () => Promise<void>
  createDeck: (label: string) => Promise<void>
  patchDeck: (
    deckId: string,
    patch: { label?: string; enabled?: boolean }
  ) => Promise<void>
  deleteDeck: (deckId: string) => Promise<void>
  moveDeck: (deckId: string, direction: -1 | 1) => Promise<void>
  uploadSlide: (deckId: string, file: File, title?: string) => Promise<void>
  patchSlide: (
    deckId: string,
    slideId: string,
    patch: { title?: string }
  ) => Promise<void>
  deleteSlide: (deckId: string, slideId: string) => Promise<void>
  moveSlide: (
    deckId: string,
    slideId: string,
    direction: -1 | 1
  ) => Promise<void>
}

export function useScenarioSlideshows(
  scenarioId: string | null
): ScenarioSlideshowsState {
  const [decks, setDecks] = useState<RuntimeSlideshowDeck[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminToken, setAdminTokenState] = useState(
    () => window.localStorage.getItem('twinAdminToken') ?? ''
  )

  const setAdminToken = useCallback((token: string) => {
    setAdminTokenState(token)
    if (token.length > 0) {
      window.localStorage.setItem('twinAdminToken', token)
    } else {
      window.localStorage.removeItem('twinAdminToken')
    }
  }, [])

  const refresh = useCallback(async () => {
    if (scenarioId == null) {
      setDecks([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const suffix = adminOpen ? '?includeDisabled=1' : ''
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
  }, [adminOpen, scenarioId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const mutate = useCallback(
    async (request: () => Promise<Response>): Promise<void> => {
      setError(null)
      try {
        await jsonOrThrow(await request())
        await refresh()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'authoring update failed')
      }
    },
    [refresh]
  )

  const createDeck = useCallback(
    async (label: string) => {
      if (scenarioId == null) return
      await mutate(
        async () =>
          await fetch('/api/authoring/slideshows', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...authHeaders(adminToken)
            },
            body: JSON.stringify({ scenarioId, label })
          })
      )
    },
    [adminToken, mutate, scenarioId]
  )

  const patchDeck = useCallback(
    async (deckId: string, patch: { label?: string; enabled?: boolean }) => {
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(deckId)}`,
            {
              method: 'PATCH',
              headers: {
                'content-type': 'application/json',
                ...authHeaders(adminToken)
              },
              body: JSON.stringify(patch)
            }
          )
      )
    },
    [adminToken, mutate]
  )

  const deleteDeck = useCallback(
    async (deckId: string) => {
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(deckId)}`,
            {
              method: 'DELETE',
              headers: authHeaders(adminToken)
            }
          )
      )
    },
    [adminToken, mutate]
  )

  const moveDeck = useCallback(
    async (deckId: string, direction: -1 | 1) => {
      if (scenarioId == null) return
      const ids = moveId(
        decks.map(deck => deck.id),
        deckId,
        direction
      )
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/scenarios/${encodeURIComponent(
              scenarioId
            )}/slideshow-order`,
            {
              method: 'PATCH',
              headers: {
                'content-type': 'application/json',
                ...authHeaders(adminToken)
              },
              body: JSON.stringify({ ids })
            }
          )
      )
    },
    [adminToken, decks, mutate, scenarioId]
  )

  const uploadSlide = useCallback(
    async (deckId: string, file: File, title?: string) => {
      const formData = new FormData()
      formData.set('file', file)
      if (title != null) formData.set('title', title)
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(deckId)}/slides`,
            {
              method: 'POST',
              headers: authHeaders(adminToken),
              body: formData
            }
          )
      )
    },
    [adminToken, mutate]
  )

  const patchSlide = useCallback(
    async (deckId: string, slideId: string, patch: { title?: string }) => {
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(
              deckId
            )}/slides/${encodeURIComponent(slideId)}`,
            {
              method: 'PATCH',
              headers: {
                'content-type': 'application/json',
                ...authHeaders(adminToken)
              },
              body: JSON.stringify(patch)
            }
          )
      )
    },
    [adminToken, mutate]
  )

  const deleteSlide = useCallback(
    async (deckId: string, slideId: string) => {
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(
              deckId
            )}/slides/${encodeURIComponent(slideId)}`,
            {
              method: 'DELETE',
              headers: authHeaders(adminToken)
            }
          )
      )
    },
    [adminToken, mutate]
  )

  const moveSlide = useCallback(
    async (deckId: string, slideId: string, direction: -1 | 1) => {
      const deck = decks.find(candidate => candidate.id === deckId)
      if (deck == null) return
      const ids = moveId(
        deck.slides.map(slide => slide.id),
        slideId,
        direction
      )
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(deckId)}/slide-order`,
            {
              method: 'PATCH',
              headers: {
                'content-type': 'application/json',
                ...authHeaders(adminToken)
              },
              body: JSON.stringify({ ids })
            }
          )
      )
    },
    [adminToken, decks, mutate]
  )

  return useMemo(
    () => ({
      decks,
      loading,
      error,
      adminOpen,
      adminToken,
      setAdminOpen,
      setAdminToken,
      refresh,
      createDeck,
      patchDeck,
      deleteDeck,
      moveDeck,
      uploadSlide,
      patchSlide,
      deleteSlide,
      moveSlide
    }),
    [
      adminOpen,
      adminToken,
      createDeck,
      decks,
      deleteDeck,
      deleteSlide,
      error,
      loading,
      moveDeck,
      moveSlide,
      patchDeck,
      patchSlide,
      refresh,
      setAdminToken,
      uploadSlide
    ]
  )
}

function moveId(ids: string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id)
  if (index < 0) return ids
  const nextIndex = Math.max(0, Math.min(ids.length - 1, index + direction))
  if (nextIndex === index) return ids
  const next = [...ids]
  const [item] = next.splice(index, 1)
  next.splice(nextIndex, 0, item)
  return next
}
