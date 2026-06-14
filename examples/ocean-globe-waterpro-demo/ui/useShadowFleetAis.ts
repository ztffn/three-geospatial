// Client hook for the globe-overview AIS layers: polls the same-origin
// BarentsWatch proxy for the live positions of EU-sanctioned shadow-fleet
// vessels (matched by IMO) and Norwegian Coast Guard / Navy patrol vessels
// (matched by name/type), both currently broadcasting in Norwegian waters.
// Returns only what the feed reports — empty until credentials are configured
// server-side; never faked.

import { useEffect, useState } from 'react'

// The wire shape is the server's VesselPosition. `import type` is erased at
// build, so this pulls in no runtime code from the core (which reads
// process.env) — same pattern as useMetForecast re-exporting the MET types.
import type { VesselPosition } from '../../../netlify/functions/_ais-core'

export type ShadowFleetPosition = VesselPosition

const ENDPOINT = '/.netlify/functions/ais-shadow-fleet'
const POLL_MS = 60_000

export function useShadowFleetAis(enabled: boolean): {
  shadowFleet: ShadowFleetPosition[]
  patrol: ShadowFleetPosition[]
  updatedAt: string | null
  error: string | null
} {
  const [shadowFleet, setShadowFleet] = useState<ShadowFleetPosition[]>([])
  const [patrol, setPatrol] = useState<ShadowFleetPosition[]>([])
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(ENDPOINT)
        const json = (await res.json()) as {
          shadowFleet?: ShadowFleetPosition[]
          patrol?: ShadowFleetPosition[]
          updatedAt?: string
          error?: string
        }
        if (cancelled) return
        if (!res.ok) {
          // 503 = credentials unset / upstream down. Keep markers empty.
          setError(json.error ?? `AIS proxy returned ${res.status}`)
          setShadowFleet([])
          setPatrol([])
          return
        }
        setError(null)
        setShadowFleet(json.shadowFleet ?? [])
        setPatrol(json.patrol ?? [])
        setUpdatedAt(json.updatedAt ?? null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'AIS fetch failed')
      }
    }
    void load()
    const id = setInterval(() => void load(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [enabled])

  return { shadowFleet, patrol, updatedAt, error }
}
