// Client access to the authored path-rig manifest: a hook fetching the public
// /api/authoring/rigs map (scenarioId → RigDocument, superseding the committed
// seeds in rig/rigSeeds.ts), and the admin PUT used by the author transport's
// save-on-edit. Mirrors useAuthoredSites; parse failures skip the entry so one
// bad document can't take down the rest of the manifest.

import { useCallback, useEffect, useState } from 'react'

import { parseRigDocument, type RigDocument } from '@huma/path-creator/core'

import type { PutRigResponse, RigsResponse } from '../authoring/types'
import { jsonOrThrow } from './useScenarioSlideshows'

export interface AuthoredRigsState {
  rigs: Record<string, RigDocument>
  updatedAt: string | null
  error: string | null
  refresh: () => Promise<void>
}

export function useAuthoredRigs(enabled: boolean): AuthoredRigsState {
  const [rigs, setRigs] = useState<Record<string, RigDocument>>({})
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled) return
    setError(null)
    try {
      const data = await jsonOrThrow<RigsResponse>(
        await fetch('/api/authoring/rigs')
      )
      const parsed: Record<string, RigDocument> = {}
      for (const [scenarioId, raw] of Object.entries(data.rigs)) {
        try {
          parsed[scenarioId] = parseRigDocument(JSON.stringify(raw))
        } catch {
          // Skip the malformed entry; its seed (if any) stays in effect.
        }
      }
      setRigs(parsed)
      setUpdatedAt(data.updatedAt)
    } catch (err: unknown) {
      // Leave the last-known map in place; the seeds still work.
      setError(
        err instanceof Error ? err.message : 'failed to load authored rigs'
      )
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { rigs, updatedAt, error, refresh }
}

/** Persist one scenario's RigDocument (admin session required); throws on
 * failure so callers can surface the save error. */
export async function putRigDocument(
  scenarioId: string,
  document: RigDocument
): Promise<string> {
  const data = await jsonOrThrow<PutRigResponse>(
    await fetch(`/api/authoring/rigs/${encodeURIComponent(scenarioId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(document)
    })
  )
  return data.updatedAt
}
