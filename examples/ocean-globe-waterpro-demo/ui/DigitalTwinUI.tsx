// Digital-twin overlay layer for the deployed globe ocean scene. Composes the
// live MET conditions card (floating glass, top-right) and the forecast time
// scrubber (bottom-centre), sharing one selected-time state so scrubbing the
// timeline re-reads the interpolated wind/wave/sea conditions. Plain DOM mounted
// as a sibling of the R3F canvas; fed real data via useMetForecast (no mocks).

import { useEffect, useMemo, useState, type FC } from 'react'

import { useMetForecast, type MetSample } from './useMetForecast'

// --- design tokens (Huma system, tuned for legibility over a 3D scene) -------
const PANEL_BG = 'rgba(10, 18, 30, 0.55)'
const PANEL_BORDER = '1px solid rgba(255, 255, 255, 0.10)'
const TEXT = '#e8eef5'
const MUTED = 'rgba(232, 238, 245, 0.55)'
const ACCENT = 'oklch(0.6671 0.2199 26.4681)' // huma primary (warm)
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
const SANS =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const CARDINALS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'
]
const cardinal = (deg: number): string =>
  CARDINALS[Math.round(deg / 22.5) % 16]

// Format a numeric field, rendering an em dash when MET has no value (rather
// than a fabricated 0). `dir` appends the compass bearing + cardinal.
const fmt = (
  v: number | null,
  unit: string,
  digits = 1
): string => (v == null ? '—' : `${v.toFixed(digits)} ${unit}`)
const fmtDir = (v: number | null): string =>
  v == null ? '' : `${cardinal(v)} ${Math.round(v)}°`

// --- conditions card ---------------------------------------------------------
const Row: FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children
}) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: 16,
      padding: '6px 0',
      borderTop: '1px solid rgba(255,255,255,0.06)'
    }}
  >
    <span
      style={{
        fontFamily: SANS,
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: MUTED
      }}
    >
      {label}
    </span>
    <span
      style={{
        fontFamily: MONO,
        fontSize: 13,
        fontVariantNumeric: 'tabular-nums',
        color: TEXT,
        textAlign: 'right'
      }}
    >
      {children}
    </span>
  </div>
)

const ConditionsCard: FC<{
  locationName: string
  sample: MetSample | null
  loading: boolean
  error: string | null
}> = ({ locationName, sample, loading, error }) => (
  <div
    style={{
      position: 'fixed',
      // Below the collapsed Leva dev panel (top-right default ~40px bar); both
      // right-aligned so they stack rather than overlap.
      top: 60,
      right: 16,
      width: 248,
      padding: '14px 16px',
      background: PANEL_BG,
      border: PANEL_BORDER,
      borderRadius: 0,
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      color: TEXT,
      pointerEvents: 'none',
      zIndex: 6
    }}
  >
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 8
      }}
    >
      <span
        style={{
          fontFamily: SANS,
          fontSize: 11,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: ACCENT
        }}
      >
        Conditions
      </span>
      <span style={{ fontFamily: SANS, fontSize: 11, color: MUTED }}>
        {locationName}
      </span>
    </div>

    {error != null ? (
      <div style={{ fontFamily: SANS, fontSize: 12, color: MUTED }}>
        Data unavailable: {error}
      </div>
    ) : sample == null ? (
      <div style={{ fontFamily: SANS, fontSize: 12, color: MUTED }}>
        {loading ? 'Loading forecast…' : 'No data'}
      </div>
    ) : (
      <>
        <Row label="Wind">
          {fmt(sample.windSpeed, 'm/s')}{' '}
          <span style={{ color: MUTED }}>
            {fmtDir(sample.windFromDirection)}
          </span>
        </Row>
        <Row label="Gust">{fmt(sample.windGust, 'm/s')}</Row>
        <Row label="Wave">
          {fmt(sample.waveHeight, 'm')}{' '}
          <span style={{ color: MUTED }}>
            {fmtDir(sample.waveFromDirection)}
          </span>
        </Row>
        <Row label="Sea temp">{fmt(sample.seaTemperature, '°C')}</Row>
        <Row label="Current">{fmt(sample.currentSpeed, 'm/s')}</Row>
        <Row label="Air temp">{fmt(sample.airTemperature, '°C')}</Row>
        <Row label="Pressure">{fmt(sample.airPressure, 'hPa', 0)}</Row>
      </>
    )}

    <div
      style={{
        marginTop: 10,
        fontFamily: SANS,
        fontSize: 9,
        letterSpacing: '0.04em',
        color: 'rgba(232,238,245,0.4)'
      }}
    >
      MET Norway · CC BY 4.0
    </div>
  </div>
)

// --- time scrubber -----------------------------------------------------------
const HOUR = 3600 * 1000

const scrubberLabel = (selected: number, now: number): string => {
  const offsetH = Math.round((selected - now) / HOUR)
  const when = new Date(selected).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
  const rel =
    offsetH === 0 ? 'NOW' : offsetH > 0 ? `+${offsetH} h` : `${offsetH} h`
  return `${when} · ${rel}`
}

const TimeScrubber: FC<{
  rangeStart: number
  rangeEnd: number
  now: number
  selected: number
  onChange: (ms: number) => void
}> = ({ rangeStart, rangeEnd, now, selected, onChange }) => {
  const nowPct =
    rangeEnd > rangeStart
      ? ((now - rangeStart) / (rangeEnd - rangeStart)) * 100
      : 0
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(620px, 86vw)',
        padding: '12px 16px',
        background: PANEL_BG,
        border: PANEL_BORDER,
        borderRadius: 0,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        pointerEvents: 'auto',
        zIndex: 6
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8
        }}
      >
        <span
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: MUTED
          }}
        >
          Forecast time
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
            color: selected === now ? ACCENT : TEXT
          }}
        >
          {scrubberLabel(selected, now)}
        </span>
        <button
          type="button"
          onClick={() => onChange(now)}
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: TEXT,
            background: 'transparent',
            border: PANEL_BORDER,
            borderRadius: 0,
            padding: '3px 8px',
            cursor: 'pointer'
          }}
        >
          Now
        </button>
      </div>

      <div style={{ position: 'relative' }}>
        {/* 'now' marker on the track */}
        <div
          style={{
            position: 'absolute',
            left: `${nowPct}%`,
            top: -2,
            bottom: -2,
            width: 2,
            background: ACCENT,
            opacity: 0.7,
            pointerEvents: 'none'
          }}
        />
        <input
          className="dt-scrub"
          type="range"
          min={rangeStart}
          max={rangeEnd}
          step={HOUR / 4}
          value={selected}
          onChange={e => onChange(Number(e.target.value))}
          style={{ width: '100%', display: 'block' }}
        />
      </div>
      <style>{`
        .dt-scrub { -webkit-appearance: none; appearance: none; height: 4px;
          background: rgba(255,255,255,0.18); border-radius: 0; outline: none; }
        .dt-scrub::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
          width: 12px; height: 16px; border-radius: 0; background: ${TEXT};
          cursor: pointer; border: none; }
        .dt-scrub::-moz-range-thumb { width: 12px; height: 16px; border-radius: 0;
          background: ${TEXT}; cursor: pointer; border: none; }
      `}</style>
    </div>
  )
}

// --- composition -------------------------------------------------------------
export const DigitalTwinUI: FC<{
  latitude: number
  longitude: number
  locationName: string
}> = ({ latitude, longitude, locationName }) => {
  const { loading, error, rangeStart, rangeEnd, sampleAt } = useMetForecast(
    latitude,
    longitude
  )

  // Selected forecast instant. Defaults to (and follows) now until the user
  // scrubs. We re-clamp 'now' each minute so the live default stays current.
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<number | null>(null)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60 * 1000)
    return () => clearInterval(id)
  }, [])

  const clampedNow = useMemo(() => {
    if (rangeStart == null || rangeEnd == null) return now
    return Math.min(Math.max(now, rangeStart), rangeEnd)
  }, [now, rangeStart, rangeEnd])

  const effectiveSelected = selected ?? clampedNow
  const sample = useMemo(
    () => sampleAt(new Date(effectiveSelected)),
    [sampleAt, effectiveSelected]
  )

  return (
    <>
      <ConditionsCard
        locationName={locationName}
        sample={sample}
        loading={loading}
        error={error}
      />
      {rangeStart != null && rangeEnd != null && (
        <TimeScrubber
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          now={clampedNow}
          selected={effectiveSelected}
          onChange={setSelected}
        />
      )}
    </>
  )
}
