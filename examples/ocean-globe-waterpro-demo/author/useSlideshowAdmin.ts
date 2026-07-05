// Slideshow CRUD mutations for the author panel: create/rename/enable/delete
// decks, upload/title/reorder/delete slides, against /api/authoring (admin
// session cookie rides along automatically). Split out of the old combined
// useScenarioSlideshows so mutation code ships only in the author bundle.
// Every successful mutation invokes onMutated (the deck-list refetch).

import { useCallback, useState } from 'react'

import type { RuntimeSlideshowDeck } from '../authoring/types'
import { jsonOrThrow } from '../ui/useScenarioSlideshows'

export interface SlideshowAdminState {
  error: string | null
  createDeck: (scenarioId: string, label: string) => Promise<void>
  patchDeck: (
    deckId: string,
    patch: { label?: string; enabled?: boolean }
  ) => Promise<void>
  deleteDeck: (deckId: string) => Promise<void>
  moveDeck: (
    scenarioId: string,
    decks: RuntimeSlideshowDeck[],
    deckId: string,
    direction: -1 | 1
  ) => Promise<void>
  uploadSlide: (deckId: string, file: File, title?: string) => Promise<void>
  addCodeSlide: (
    deckId: string,
    input: { type: 'html' | 'jsx'; code: string; title?: string }
  ) => Promise<void>
  patchSlide: (
    deckId: string,
    slideId: string,
    patch: { title?: string }
  ) => Promise<void>
  deleteSlide: (deckId: string, slideId: string) => Promise<void>
  moveSlide: (
    deck: RuntimeSlideshowDeck,
    slideId: string,
    direction: -1 | 1
  ) => Promise<void>
}

export function useSlideshowAdmin(
  onMutated: () => Promise<void>
): SlideshowAdminState {
  const [error, setError] = useState<string | null>(null)

  const mutate = useCallback(
    async (request: () => Promise<Response>): Promise<void> => {
      setError(null)
      try {
        await jsonOrThrow(await request())
        await onMutated()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'authoring update failed')
      }
    },
    [onMutated]
  )

  const createDeck = useCallback(
    async (scenarioId: string, label: string) => {
      await mutate(
        async () =>
          await fetch('/api/authoring/slideshows', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scenarioId, label })
          })
      )
    },
    [mutate]
  )

  const patchDeck = useCallback(
    async (deckId: string, patch: { label?: string; enabled?: boolean }) => {
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(deckId)}`,
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch)
            }
          )
      )
    },
    [mutate]
  )

  const deleteDeck = useCallback(
    async (deckId: string) => {
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(deckId)}`,
            { method: 'DELETE' }
          )
      )
    },
    [mutate]
  )

  const moveDeck = useCallback(
    async (
      scenarioId: string,
      decks: RuntimeSlideshowDeck[],
      deckId: string,
      direction: -1 | 1
    ) => {
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
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids })
            }
          )
      )
    },
    [mutate]
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
            { method: 'POST', body: formData }
          )
      )
    },
    [mutate]
  )

  const addCodeSlide = useCallback(
    async (
      deckId: string,
      input: { type: 'html' | 'jsx'; code: string; title?: string }
    ) => {
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(deckId)}/slides`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input)
            }
          )
      )
    },
    [mutate]
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
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch)
            }
          )
      )
    },
    [mutate]
  )

  const deleteSlide = useCallback(
    async (deckId: string, slideId: string) => {
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(
              deckId
            )}/slides/${encodeURIComponent(slideId)}`,
            { method: 'DELETE' }
          )
      )
    },
    [mutate]
  )

  const moveSlide = useCallback(
    async (deck: RuntimeSlideshowDeck, slideId: string, direction: -1 | 1) => {
      const ids = moveId(
        deck.slides.map(slide => slide.id),
        slideId,
        direction
      )
      await mutate(
        async () =>
          await fetch(
            `/api/authoring/slideshows/${encodeURIComponent(deck.id)}/slide-order`,
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids })
            }
          )
      )
    },
    [mutate]
  )

  return {
    error,
    createDeck,
    patchDeck,
    deleteDeck,
    moveDeck,
    uploadSlide,
    addCodeSlide,
    patchSlide,
    deleteSlide,
    moveSlide
  }
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
