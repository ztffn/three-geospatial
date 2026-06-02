// Client-side hook for the digital-twin HUD: fetches the merged MET forecast
// from our same-origin proxy for a lat/lon, refetches when MET's data expires,
// and exposes sampleAt(date) which linearly interpolates the hourly series to
// any instant (the time scrubber's selected time). Holds real data only — on
// error it surfaces the error and leaves samples null; nothing is synthesised.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { MetForecast, MetSample } from '../../../netlify/functions/_met-core'

export type { MetForecast, MetSample }

interface ForecastState {
  data: MetForecast | null
  loading: boolean
  error: string | null
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f

// Shortest-arc interpolation for compass bearings (deg). Avoids the 359->1
// wrap producing a backwards sweep through 180.
const lerpAngle = (a: number, b: number, f: number): number => {
  const delta = ((b - a + 540) % 360) - 180
  return (a + delta * f + 360) % 360
}

// Interpolate one field across two samples. Null if either endpoint lacks it
// (e.g. wave data outside oceanforecast coverage) — never invented.
const field = (
  lo: MetSample,
  hi: MetSample,
  f: number,
  key: keyof MetSample,
  angular = false
): number | null => {
  const a = lo[key]
  const b = hi[key]
  if (typeof a !== 'number' || typeof b !== 'number') return null
  return angular ? lerpAngle(a, b, f) : lerp(a, b, f)
}

function interpolate(series: MetSample[], at: number): MetSample | null {
  if (series.length === 0) return null
  const first = series[0]
  const last = series[series.length - 1]
  if (at <= Date.parse(first.time)) return first
  if (at >= Date.parse(last.time)) return last

  let hiIdx = 1
  while (hiIdx < series.length && Date.parse(series[hiIdx].time) < at) hiIdx++
  const lo = series[hiIdx - 1]
  const hi = series[hiIdx]
  const loT = Date.parse(lo.time)
  const hiT = Date.parse(hi.time)
  const f = hiT === loT ? 0 : (at - loT) / (hiT - loT)

  return {
    time: new Date(at).toISOString(),
    windSpeed: field(lo, hi, f, 'windSpeed'),
    windFromDirection: field(lo, hi, f, 'windFromDirection', true),
    windGust: field(lo, hi, f, 'windGust'),
    airTemperature: field(lo, hi, f, 'airTemperature'),
    airPressure: field(lo, hi, f, 'airPressure'),
    cloudFraction: field(lo, hi, f, 'cloudFraction'),
    relativeHumidity: field(lo, hi, f, 'relativeHumidity'),
    waveHeight: field(lo, hi, f, 'waveHeight'),
    waveFromDirection: field(lo, hi, f, 'waveFromDirection', true),
    seaTemperature: field(lo, hi, f, 'seaTemperature'),
    currentSpeed: field(lo, hi, f, 'currentSpeed'),
    currentToDirection: field(lo, hi, f, 'currentToDirection', true),
    // Categorical/accumulated — take the containing hour (lo), don't interpolate.
    symbolCode: lo.symbolCode,
    precipitation: lo.precipitation
  }
}

export interface UseMetForecast extends ForecastState {
  // Inclusive time bounds of the loaded series (ms epoch), or null while empty.
  rangeStart: number | null
  rangeEnd: number | null
  // Interpolated conditions at an arbitrary instant; null until data loads.
  sampleAt: (date: Date) => MetSample | null
}

export function useMetForecast(lat: number, lon: number): UseMetForecast {
  const [state, setState] = useState<ForecastState>({
    data: null,
    loading: true,
    error: null
  })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      setState(s => ({ ...s, loading: true, error: null }))
      try {
        const res = await fetch(
          `/.netlify/functions/met?lat=${lat}&lon=${lon}`
        )
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setState({ data: null, loading: false, error: json.error ?? `HTTP ${res.status}` })
          return
        }
        const data = json as MetForecast
        setState({ data, loading: false, error: null })
        // Refetch when MET's data expires (clamped 1 min .. 1 h). Data refresh,
        // not a loading-readiness timer.
        const ms = Math.min(
          60 * 60 * 1000,
          Math.max(60 * 1000, Date.parse(data.expires) - Date.now())
        )
        timerRef.current = setTimeout(() => void load(), ms)
      } catch (err) {
        if (cancelled) return
        setState({ data: null, loading: false, error: (err as Error).message })
      }
    }

    void load()
    return () => {
      cancelled = true
      if (timerRef.current != null) clearTimeout(timerRef.current)
    }
  }, [lat, lon])

  const series = state.data?.series
  const sampleAt = useCallback(
    (date: Date): MetSample | null =>
      series != null ? interpolate(series, date.getTime()) : null,
    [series]
  )

  return {
    ...state,
    rangeStart:
      series != null && series.length > 0 ? Date.parse(series[0].time) : null,
    rangeEnd:
      series != null && series.length > 0
        ? Date.parse(series[series.length - 1].time)
        : null,
    sampleAt
  }
}
