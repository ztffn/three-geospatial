// Client hook for one vessel's last-24h historic track. Fetches the same-origin
// BarentsWatch historic proxy by MMSI whenever the selected vessel changes (null
// MMSI clears it). On-demand, single vessel — distinct from the polling
// shadow-fleet position hook. Returns only the points the feed reports; an empty
// array is a valid answer (vessel had no fixes in coverage), never fabricated.

import { useEffect, useState } from 'react'

import type { TrackPoint } from '../../../netlify/functions/_ais-core'

export type VesselTrackPoint = TrackPoint

const ENDPOINT = '/.netlify/functions/ais-track'

export function useVesselTrack(mmsi: number | null): {
  points: VesselTrackPoint[]
  error: string | null
} {
  const [points, setPoints] = useState<VesselTrackPoint[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mmsi == null) {
      setPoints([])
      setError(null)
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`${ENDPOINT}?mmsi=${mmsi}`)
        const json = (await res.json()) as {
          points?: VesselTrackPoint[]
          error?: string
        }
        if (cancelled) return
        if (!res.ok) {
          setError(json.error ?? `track proxy returned ${res.status}`)
          setPoints([])
          return
        }
        setError(null)
        setPoints(json.points ?? [])
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'track fetch failed')
        setPoints([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [mmsi])

  return { points, error }
}
