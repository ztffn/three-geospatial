// Digital-twin overlay layer for the deployed globe ocean scene. Presentational
// only: the MET conditions card (top-right), the modelled turbine inspector
// (top-left, under the brand mark), and the forecast time scrubber (bottom).
// All data — the interpolated MET sample, the turbine telemetry, and the
// selected time — is owned by main.tsx App and passed in, so the DOM cards and
// the 3D turbine share one source of truth. Plain DOM sibling of the canvas.

import { type FC } from 'react'

import type { MetSample } from './useMetForecast'
import type { TurbineTelemetry, TurbineStatus } from './turbineModel'

// --- design tokens (Huma system, tuned for legibility over a 3D scene) -------
const PANEL_BG = 'rgba(10, 18, 30, 0.55)'
const PANEL_BORDER = '1px solid rgba(255, 255, 255, 0.10)'
const TEXT = '#e8eef5'
const MUTED = 'rgba(232, 238, 245, 0.55)'
const ACCENT = 'oklch(0.6671 0.2199 26.4681)' // huma primary (warm)
const GOOD = 'oklch(0.72 0.17 145)' // generating/rated (green)
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
const SANS =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const cardStyle = (
  pos: { top?: number; bottom?: number; left?: number; right?: number },
  width: number
): React.CSSProperties => ({
  position: 'fixed',
  ...pos,
  width,
  padding: '14px 16px',
  background: PANEL_BG,
  border: PANEL_BORDER,
  borderRadius: 0,
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  color: TEXT,
  pointerEvents: 'none',
  zIndex: 6
})

const CARDINALS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'
]
const cardinal = (deg: number): string =>
  CARDINALS[Math.round(deg / 22.5) % 16]

// Render a numeric field as an em dash when MET has no value (rather than a
// fabricated 0). `dir` renders the compass bearing + cardinal.
const fmt = (v: number | null, unit: string, digits = 1): string =>
  v == null ? '—' : `${v.toFixed(digits)} ${unit}`
const fmtDir = (v: number | null): string =>
  v == null ? '' : `${cardinal(v)} ${Math.round(v)}°`

// Humanise a MET symbol_code (e.g. 'partlycloudy_day', 'heavyrainandthunder')
// into a readable condition. Cloud states are fixed phrases; precipitation
// codes are composed from intensity + type + showers + thunder.
const CONDITION_SPECIAL: Record<string, string> = {
  clearsky: 'Clear sky',
  fair: 'Fair',
  partlycloudy: 'Partly cloudy',
  cloudy: 'Overcast',
  fog: 'Fog'
}
const conditionText = (code: string | null): string => {
  if (code == null) return '—'
  let c = code.replace(/_(day|night|polartwilight)$/, '')
  if (CONDITION_SPECIAL[c] != null) return CONDITION_SPECIAL[c]
  const thunder = c.endsWith('andthunder')
  if (thunder) c = c.slice(0, -'andthunder'.length)
  const showers = c.endsWith('showers')
  if (showers) c = c.slice(0, -'showers'.length)
  let intensity = ''
  if (c.startsWith('light')) {
    intensity = 'Light '
    c = c.slice(5)
  } else if (c.startsWith('heavy')) {
    intensity = 'Heavy '
    c = c.slice(5)
  }
  const text =
    `${intensity}${c}${showers ? ' showers' : ''}${thunder ? ' and thunder' : ''}`.trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const CardHeader: FC<{ title: string; right?: React.ReactNode }> = ({
  title,
  right
}) => (
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
      {title}
    </span>
    {right}
  </div>
)

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

const Footnote: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      marginTop: 10,
      fontFamily: SANS,
      fontSize: 9,
      letterSpacing: '0.04em',
      color: 'rgba(232,238,245,0.4)'
    }}
  >
    {children}
  </div>
)

// --- conditions card ---------------------------------------------------------
const ConditionsCard: FC<{
  locationName: string
  sample: MetSample | null
  loading: boolean
  error: string | null
}> = ({ locationName, sample, loading, error }) => (
  <div style={cardStyle({ top: 60, right: 16 }, 248)}>
    <CardHeader
      title="Conditions"
      right={
        <span style={{ fontFamily: SANS, fontSize: 11, color: MUTED }}>
          {locationName}
        </span>
      }
    />
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
        <Row label="Sky">{conditionText(sample.symbolCode)}</Row>
        <Row label="Wind">
          {fmt(sample.windSpeed, 'm/s')}{' '}
          <span style={{ color: MUTED }}>
            {fmtDir(sample.windFromDirection)}
          </span>
        </Row>
        <Row label="Gust">{fmt(sample.windGust, 'm/s')}</Row>
        <Row label="Precip">{fmt(sample.precipitation, 'mm', 1)}</Row>
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
    <Footnote>MET Norway · CC BY 4.0</Footnote>
  </div>
)

// --- turbine inspector -------------------------------------------------------
const STATUS_COLOR: Record<TurbineStatus, string> = {
  'No data': MUTED,
  Parked: MUTED,
  Generating: GOOD,
  Rated: GOOD,
  'Cut-out': ACCENT
}

const TurbineInspector: FC<{
  telemetry: TurbineTelemetry
  count: number
}> = ({ telemetry, count }) => (
  <div style={cardStyle({ top: 76, left: 16 }, 232)}>
    <CardHeader
      title="Turbine"
      right={
        <span
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: count === 0 ? MUTED : STATUS_COLOR[telemetry.status]
          }}
        >
          {count === 0 ? 'None' : telemetry.status}
        </span>
      }
    />
    {count === 0 ? (
      <div style={{ fontFamily: SANS, fontSize: 12, color: MUTED }}>
        No turbines at this site.
      </div>
    ) : (
      <>
        <Row label="Power">
          {fmt(telemetry.powerMW, 'MW', 2)}
          {telemetry.capacityFactor != null && (
            <span style={{ color: MUTED }}>
              {'  '}
              {(telemetry.capacityFactor * 100).toFixed(0)}%
            </span>
          )}
        </Row>
        <Row label="Rotor">{fmt(telemetry.rpm, 'rpm')}</Row>
        <Row label="Blade pitch">{fmt(telemetry.pitchDeg, '°')}</Row>
        <Row label="Yaw">
          <span style={{ color: MUTED }}>{fmtDir(telemetry.yawHeading)}</span>
        </Row>
        <Row label={`Farm · ${count}×`}>
          {telemetry.powerMW == null
            ? '—'
            : `${(telemetry.powerMW * count).toFixed(1)} MW`}
        </Row>
        <Footnote>Modelled · {count} × 8 MW ref · from forecast wind</Footnote>
      </>
    )}
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
  // number = scrub to a fixed instant; null = resume following live 'now'.
  onChange: (ms: number | null) => void
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
          onClick={() => onChange(null)}
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

// --- camera controls panel ---------------------------------------------------
export interface Poi {
  name: string // must match a scene location-preset key
  longitude: number
  latitude: number
  label?: string // optional shorter button text (defaults to name)
  turbines: number // units at this site (0 = none, e.g. Oslo)
}

export interface CameraControlsState {
  pois: Poi[]
  activePoi: string
  onFlyTo: (poi: Poi) => void
  autoRotate: boolean
  onAutoRotate: (v: boolean) => void
  zoom: number
  zoomMin: number
  zoomMax: number
  onZoom: (v: number) => void
  wingsOn: boolean
  onWings: (v: boolean) => void
}

const PinIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="10" r="2.2" fill="currentColor" />
  </svg>
)

// On/off pill, gray when off, accent when on ("color for meaning").
const Toggle: FC<{ label: string; on: boolean; onChange: (v: boolean) => void }> = ({
  label,
  on,
  onChange
}) => (
  <button
    type="button"
    onClick={() => onChange(!on)}
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      width: '100%',
      gap: 10,
      padding: '6px 8px',
      fontFamily: SANS,
      fontSize: 11,
      letterSpacing: '0.04em',
      color: TEXT,
      background: 'transparent',
      border: PANEL_BORDER,
      borderRadius: 0,
      cursor: 'pointer'
    }}
  >
    {label}
    <span
      style={{
        width: 28,
        height: 14,
        borderRadius: 0,
        background: on ? ACCENT : 'rgba(255,255,255,0.15)',
        position: 'relative',
        transition: 'background-color 150ms cubic-bezier(0.4,0,0.2,1)'
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 10,
          height: 10,
          background: TEXT,
          transition: 'left 150ms cubic-bezier(0.4,0,0.2,1)'
        }}
      />
    </span>
  </button>
)

const ControlsPanel: FC<CameraControlsState> = ({
  pois,
  activePoi,
  onFlyTo,
  autoRotate,
  onAutoRotate,
  zoom,
  zoomMin,
  zoomMax,
  onZoom,
  wingsOn,
  onWings
}) => (
  <div
    style={{
      ...cardStyle({ bottom: 16, left: 16 }, 220),
      pointerEvents: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }}
  >
    <CardHeader title="Camera" />

    {/* POI fly-to buttons */}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {pois.map(poi => {
        const active = poi.name === activePoi
        return (
          <button
            key={poi.name}
            type="button"
            onClick={() => onFlyTo(poi)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 9px',
              fontFamily: SANS,
              fontSize: 11,
              letterSpacing: '0.02em',
              color: active ? ACCENT : TEXT,
              background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
              border: PANEL_BORDER,
              borderRadius: 0,
              cursor: 'pointer'
            }}
          >
            <PinIcon />
            {poi.label ?? poi.name}
          </button>
        )
      })}
    </div>

    {/* Zoom puller */}
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: SANS,
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: MUTED,
          marginBottom: 4
        }}
      >
        <span>Zoom</span>
        <span style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(zoom)} m
        </span>
      </div>
      {/* Larger value = farther out; invert so dragging right zooms IN. */}
      <input
        className="dt-scrub"
        type="range"
        min={zoomMin}
        max={zoomMax}
        step={Math.max(1, Math.round((zoomMax - zoomMin) / 200))}
        value={zoomMax + zoomMin - zoom}
        onChange={e => onZoom(zoomMax + zoomMin - Number(e.target.value))}
        style={{ width: '100%', display: 'block' }}
      />
    </div>

    <Toggle label="Auto-rotate" on={autoRotate} onChange={onAutoRotate} />
    <Toggle label="Rotor spin" on={wingsOn} onChange={onWings} />
  </div>
)

// --- composition (presentational) -------------------------------------------
export const DigitalTwinUI: FC<{
  locationName: string
  loading: boolean
  error: string | null
  sample: MetSample | null
  telemetry: TurbineTelemetry
  turbineCount: number
  rangeStart: number | null
  rangeEnd: number | null
  now: number
  selected: number
  onScrub: (ms: number | null) => void
  cameraControls?: CameraControlsState
}> = ({
  locationName,
  loading,
  error,
  sample,
  telemetry,
  turbineCount,
  rangeStart,
  rangeEnd,
  now,
  selected,
  onScrub,
  cameraControls
}) => (
  <>
    <TurbineInspector telemetry={telemetry} count={turbineCount} />
    <ConditionsCard
      locationName={locationName}
      sample={sample}
      loading={loading}
      error={error}
    />
    {cameraControls != null && <ControlsPanel {...cameraControls} />}
    {rangeStart != null && rangeEnd != null && (
      <TimeScrubber
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        now={now}
        selected={selected}
        onChange={onScrub}
      />
    )}
  </>
)
