// Client hook for authored site data: fetches the public site manifest
// (/api/authoring/sites) and returns the raw SiteDefinitions. Visitor-facing —
// TwinExperience composes these with the static catalogue via
// sites/runtime.composeScenarioCatalogue (new scenarios + view extensions on
// anchor-matching static scenarios). Author mode calls refresh after saving.

import { useCallback, useEffect, useState } from 'react'

import type { SitesResponse } from '../authoring/types'
import type { SiteDefinition } from '../sites/types'
import { jsonOrThrow } from './useScenarioSlideshows'

export interface AuthoredSitesState {
  sites: SiteDefinition[]
  // Server manifest timestamp; null when nothing has been authored yet.
  updatedAt: string | null
  error: string | null
  refresh: () => Promise<void>
}

// includeDisabled requests the admin view (draft scenarios too); the server
// only honors it with an authenticated admin session (see api.ts).
export function useAuthoredSites(
  includeDisabled = false
): AuthoredSitesState {
  const [sites, setSites] = useState<SiteDefinition[]>([])
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const suffix = includeDisabled ? '?includeDisabled=1' : ''
      const data = await jsonOrThrow<SitesResponse>(
        await fetch(`/api/authoring/sites${suffix}`)
      )
      setSites(data.sites)
      setUpdatedAt(data.updatedAt)
    } catch (err: unknown) {
      // Leave the last-known list in place; the static catalogue still works.
      setError(
        err instanceof Error ? err.message : 'failed to load authored sites'
      )
    }
  }, [includeDisabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { sites, updatedAt, error, refresh }
}
