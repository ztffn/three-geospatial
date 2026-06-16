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
// Per-request ceiling so a slow/unreachable upstream (the BarentsWatch proxy has
// no timeout of its own) can't leave the request hanging indefinitely.
const TIMEOUT_MS = 8_000
// Transient failures (network error, request timeout, 5xx that isn't a missing-
// credentials 503) get a few quick backoff retries before settling to the slow
// poll, so a momentary blip recovers in seconds instead of a full minute.
const MAX_RETRIES = 3
const backoffMs = (attempt: number): number =>
  Math.min(2_000 * 2 ** (attempt - 1), 15_000) // 2s, 4s, 8s, capped 15s

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
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0

    // Self-rescheduling poll (setTimeout, not setInterval) so the next delay can
    // be a short backoff after a transient failure or the steady POLL_MS after a
    // success / terminal error — and so a slow request never overlaps the next.
    const schedule = (delay: number): void => {
      if (cancelled) return
      timer = setTimeout(() => void run(), delay)
    }

    const run = async (): Promise<void> => {
      if (cancelled) return
      const controller = new AbortController()
      const abort = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const res = await fetch(ENDPOINT, { signal: controller.signal })
        clearTimeout(abort)
        // Read as text first: a 503 body may be a non-JSON proxy/CDN error page,
        // and parsing that as JSON would throw and mask the real status.
        const text = await res.text()
        let json: {
          shadowFleet?: ShadowFleetPosition[]
          patrol?: ShadowFleetPosition[]
          updatedAt?: string
          error?: string
        } = {}
        try {
          json = text ? JSON.parse(text) : {}
        } catch {
          /* leave json empty — fall through to the status-based message */
        }
        if (cancelled) return
        if (!res.ok) {
          const msg = json.error ?? `AIS proxy returned ${res.status}`
          setError(msg)
          setShadowFleet([])
          setPatrol([])
          // Missing server-side credentials is a standing condition, not a blip:
          // skip the fast retries and just resume the slow poll.
          const terminal = /credential/i.test(msg)
          if (!terminal && failures < MAX_RETRIES) {
            schedule(backoffMs(++failures))
          } else {
            failures = 0
            schedule(POLL_MS)
          }
          return
        }
        setError(null)
        setShadowFleet(json.shadowFleet ?? [])
        setPatrol(json.patrol ?? [])
        setUpdatedAt(json.updatedAt ?? null)
        failures = 0
        schedule(POLL_MS)
      } catch (err) {
        clearTimeout(abort)
        if (cancelled) return
        const aborted = err instanceof Error && err.name === 'AbortError'
        setError(
          aborted
            ? 'AIS request timed out'
            : err instanceof Error
              ? err.message
              : 'AIS fetch failed'
        )
        if (failures < MAX_RETRIES) {
          schedule(backoffMs(++failures))
        } else {
          failures = 0
          schedule(POLL_MS)
        }
      }
    }

    void run()
    return () => {
      cancelled = true
      if (timer != null) clearTimeout(timer)
    }
  }, [enabled])

  return { shadowFleet, patrol, updatedAt, error }
}
