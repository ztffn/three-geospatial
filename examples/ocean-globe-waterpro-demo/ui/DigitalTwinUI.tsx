// Digital-twin overlay layer for the deployed globe ocean scene. Presentational
// only: the MET conditions card (top-right), the modelled turbine inspector
// (top-left, under the brand mark), the camera controls (bottom-left), the
// scenario picker with per-scenario settings (bottom-right), and the forecast
// time scrubber (bottom). Every panel is a collapsible Card (header click).
// All data is owned by main.tsx App and passed in. Plain DOM canvas siblings.

import { useEffect, useState, type FC } from 'react'

import type { MetSample } from './useMetForecast'
import type { TurbineTelemetry, TurbineStatus } from './turbineModel'
import type {
  AisReadings,
  BunkeringReadings,
  ProcessReadings,
  Scenario,
  SplatReadings,
  Viewpoint
} from './scenarios'
import type { VesselPosition } from '../../../netlify/functions/_ais-core'
import {
  PHASE_CLIPS,
  IDLE_CLIP,
  RIG_PHASES,
  WINCH_SWL,
  RAM_SWL,
  loadColor
} from './rigPhases'

// --- design tokens (Huma system, tuned for legibility over a 3D scene) -------
const PANEL_BG = 'rgba(10, 18, 30, 0.55)'
const PANEL_BORDER = '1px solid rgba(255, 255, 255, 0.10)'
const TEXT = '#e8eef5'
const MUTED = 'rgba(232, 238, 245, 0.55)'
const ACCENT = 'oklch(0.6671 0.2199 26.4681)' // huma primary (warm)
const PATROL_ACCENT = 'oklch(0.72 0.15 248)' // Coast Guard / Navy (blue)
const GOOD = 'oklch(0.72 0.17 145)' // generating/rated (green)
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
const SANS =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const cardStyle = (
  pos: {
    top?: number
    bottom?: number
    left?: number | string
    right?: number
  },
  width: number | string
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

// Active/inactive "pill" button style shared by the camera-mode, scenario, and
// viewpoint buttons (accent text + subtle fill when active). Layout — padding,
// gap, fontSize — stays per-call; this captures only the shared active logic.
const pillStyle = (active: boolean): React.CSSProperties => ({
  fontFamily: SANS,
  letterSpacing: '0.02em',
  color: active ? ACCENT : TEXT,
  background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
  border: PANEL_BORDER,
  borderRadius: 0,
  cursor: 'pointer'
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

const ChevronIcon: FC<{ open: boolean }> = ({ open }) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden
    style={{
      transform: open ? 'rotate(90deg)' : 'none',
      transition: 'transform 150ms cubic-bezier(0.4,0,0.2,1)'
    }}
  >
    <path
      d="M9 5l8 7-8 7"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

// Collapsible glass card shared by every panel. The header row is a button:
// clicking it folds the card down to just the header. Non-interactive cards
// (data displays) keep pointer events off their body so the globe stays
// draggable through them — only the header takes clicks.
const Card: FC<{
  pos: {
    top?: number
    bottom?: number
    left?: number | string
    right?: number
  }
  width: number | string
  title: string
  // Text-only header content (rendered inside the header button).
  headerRight?: React.ReactNode
  interactive?: boolean
  // Flex-column gap for the body (interactive control stacks).
  gap?: number
  style?: React.CSSProperties
  children: React.ReactNode
}> = ({
  pos,
  width,
  title,
  headerRight,
  interactive = false,
  gap,
  style,
  children
}) => {
  const [open, setOpen] = useState(true)
  return (
    <div
      style={{
        ...cardStyle(pos, width),
        padding: open ? '14px 16px' : '8px 16px',
        pointerEvents: interactive ? 'auto' : 'none',
        ...(open && gap != null
          ? { display: 'flex', flexDirection: 'column', gap }
          : null),
        ...style
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          width: '100%',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 10,
          padding: 0,
          marginBottom: open && gap == null ? 8 : 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          pointerEvents: 'auto',
          textAlign: 'left'
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
        <span
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            color: MUTED
          }}
        >
          {headerRight}
          <ChevronIcon open={open} />
        </span>
      </button>
      {open && children}
    </div>
  )
}

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
  <Card
    pos={{ top: 60, right: 16 }}
    width={248}
    title="Conditions"
    headerRight={
      <span style={{ fontFamily: SANS, fontSize: 11, color: MUTED }}>
        {locationName}
      </span>
    }
  >
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
  </Card>
)

// --- AIS layers card ---------------------------------------------------------
// Replaces the conditions card at the globe-overview altitude, where point
// weather is meaningless. Toggles the marker layers on/off and shows their live
// vessel counts. Colour swatch + switch match each layer's marker colour.
const ago = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

const LayerToggle: FC<{
  swatch: string
  label: string
  count: number
  on: boolean
  onChange: () => void
}> = ({ swatch, label, count, on, onChange }) => (
  <button
    type="button"
    onClick={onChange}
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
      cursor: 'pointer',
      opacity: on ? 1 : 0.5,
      transition: 'opacity 150ms'
    }}
  >
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 10, height: 10, background: swatch, flexShrink: 0 }} />
      {label}
      <span style={{ fontFamily: MONO, color: MUTED, fontVariantNumeric: 'tabular-nums' }}>
        {count}
      </span>
    </span>
    <span
      style={{
        width: 28,
        height: 14,
        background: on ? swatch : 'rgba(255,255,255,0.15)',
        position: 'relative',
        flexShrink: 0,
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

export interface AisLayersState {
  // Camera is pulled back to the overview — show this card instead of weather.
  overview: boolean
  shadowVisible: boolean
  patrolVisible: boolean
  // Live counts (currently broadcasting in Norwegian waters), independent of
  // whether the layer is toggled visible.
  shadowCount: number
  patrolCount: number
  onToggle: (layer: 'shadow' | 'patrol') => void
  // Selected-vessel overlay visibility (historic track + course projection).
  trackVisible: boolean
  projectionVisible: boolean
  onToggleOverlay: (overlay: 'track' | 'projection') => void
  // Subsea cable layers: power grid (OSM/ODbL) + telecom (TeleGeography/CC BY-NC-SA).
  cablePowerVisible: boolean
  cableTelecomVisible: boolean
  onToggleCable: (layer: 'power' | 'telecom') => void
  updatedAt: string | null
  error: string | null
}

const SectionLabel: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      fontFamily: SANS,
      fontSize: 10,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: MUTED,
      marginTop: 2
    }}
  >
    {children}
  </div>
)

const AisLayersCard: FC<AisLayersState> = ({
  shadowVisible,
  patrolVisible,
  shadowCount,
  patrolCount,
  onToggle,
  trackVisible,
  projectionVisible,
  onToggleOverlay,
  cablePowerVisible,
  cableTelecomVisible,
  onToggleCable,
  updatedAt,
  error
}) => (
  <Card
    pos={{ top: 60, right: 16 }}
    width={248}
    title="AIS layers"
    interactive
    gap={8}
    headerRight={
      <span style={{ fontFamily: SANS, fontSize: 11, color: MUTED }}>
        Norwegian waters
      </span>
    }
  >
    <LayerToggle
      swatch={ACCENT}
      label="Shadow fleet"
      count={shadowCount}
      on={shadowVisible}
      onChange={() => onToggle('shadow')}
    />
    <LayerToggle
      swatch={PATROL_ACCENT}
      label="Coast Guard / Navy"
      count={patrolCount}
      on={patrolVisible}
      onChange={() => onToggle('patrol')}
    />
    <SectionLabel>Selected vessel</SectionLabel>
    <Toggle
      label="24 h track"
      on={trackVisible}
      onChange={() => onToggleOverlay('track')}
    />
    <Toggle
      label="Course projection"
      on={projectionVisible}
      onChange={() => onToggleOverlay('projection')}
    />
    <SectionLabel>Subsea cables</SectionLabel>
    <Toggle
      label="Power grid"
      on={cablePowerVisible}
      onChange={() => onToggleCable('power')}
    />
    <Toggle
      label="Telecom"
      on={cableTelecomVisible}
      onChange={() => onToggleCable('telecom')}
    />
    <Footnote>
      {error != null
        ? `Feed unavailable: ${error}`
        : updatedAt != null
          ? `Live · BarentsWatch · updated ${ago(updatedAt)}`
          : 'Live · BarentsWatch'}
      {' · power © OpenStreetMap (ODbL) · telecom © TeleGeography (CC BY-NC-SA)'}
    </Footnote>
  </Card>
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
  <Card
    pos={{ top: 76, left: 16 }}
    width={232}
    title="Turbine"
    headerRight={
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
  >
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
  </Card>
)

// --- vessel (AIS) inspector ----------------------------------------------------
// Replaces the turbine inspector for vessel scenarios. Values are static demo
// readings from the scenario catalogue (labelled as such) until a live AIS
// feed is wired in — same card shape either way.
const aisUnderway = (status: string): boolean => /under\s*way/i.test(status)
const aisStatusColor = (status: string): string =>
  aisUnderway(status) ? GOOD : MUTED
const aisStatusBadge = (status: string): string =>
  aisUnderway(status) ? 'Underway' : status

const AisCard: FC<{ ais: AisReadings }> = ({ ais }) => (
  <Card
    pos={{ top: 76, left: 16 }}
    width={248}
    title={ais.vesselName}
    headerRight={
      <span
        style={{
          fontFamily: SANS,
          fontSize: 10,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: aisStatusColor(ais.navigationalStatus)
        }}
      >
        {aisStatusBadge(ais.navigationalStatus)}
      </span>
    }
  >
    <Row label="AIS status">{ais.navigationalStatus}</Row>
    <Row label="Speed">{fmt(ais.speedKn, 'kn', 1)}</Row>
    <Row label="Course">
      <span style={{ color: MUTED }}>{fmtDir(ais.courseDeg)}</span>
    </Row>
    <Row label="True heading">
      <span style={{ color: MUTED }}>{fmtDir(ais.headingDeg)}</span>
    </Row>
    <Row label="Rate of turn">{fmt(ais.rateOfTurnDegMin, '°/min', 0)}</Row>
    <Row label="Draught">{fmt(ais.draughtM, 'm', 1)}</Row>
    <Footnote>AIS · static demo values</Footnote>
  </Card>
)

// --- gaussian-splat inspector ------------------------------------------------
// Replaces the turbine inspector in the Realtime Geospatial scenario: a "hi-tech"
// readout of the loaded 3DGS capture. Monospace tabular figures, a live badge,
// and a derived parameter count (per-splat: 3 pos + 3 scale + 4 rot + 1 opacity +
// 3 DC colour + shCoeffs×3 SH = the radiance field's learned parameters).
const compact = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)} B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)} M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)} k`
        : `${n}`

const Mono: FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = TEXT
}) => (
  <span
    style={{ fontFamily: MONO, color, fontVariantNumeric: 'tabular-nums' }}
  >
    {children}
  </span>
)

const SplatPanel: FC<{ splat: SplatReadings }> = ({ splat }) => {
  const params = splat.totalSplats * (14 + splat.shCoeffs * 3)
  return (
    <Card
      pos={{ top: 76, left: 16 }}
      width={248}
      title="Gaussian Splats"
      headerRight={
        <span
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: GOOD
          }}
        >
          ● Live
        </span>
      }
    >
      <Row label="Splats">
        <Mono color={ACCENT}>{splat.totalSplats.toLocaleString('en-US')}</Mono>
      </Row>
      <Row label="Parameters">
        <Mono>~{compact(params)}</Mono>
      </Row>
      <Row label="SH bands">
        <Mono>
          deg {splat.shDegree}
        </Mono>{' '}
        <span style={{ color: MUTED }}>· {splat.shCoeffs} coeffs</span>
      </Row>
      <Row label="Format">
        <Mono>{splat.format}</Mono>{' '}
        <span style={{ color: MUTED }}>· {compact(splat.compressedMB * 1e6)}B</span>
      </Row>
      <Row label="Capture">
        <span style={{ color: MUTED, fontSize: 11 }}>{splat.source}</span>
      </Row>
      <Footnote>{splat.sceneName}</Footnote>
    </Card>
  )
}

// --- process-stack inspector -------------------------------------------------
// Replaces the turbine inspector at the Waste Handling site: a live-styled
// readout of the Kiln/Carbox/Arx biomass→wax plant. Headlines the zero-CO₂
// closed loop and the multi-product output (wax + O₂ + biochar).
const SplatPanelStageStrip: FC<{ stages: string[] }> = ({ stages }) => (
  <div
    style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 4,
      fontFamily: MONO,
      fontSize: 9.5,
      letterSpacing: '0.04em',
      color: MUTED,
      marginBottom: 4
    }}
  >
    {stages.map((s, i) => (
      <span key={s} style={{ display: 'inline-flex', gap: 4 }}>
        <span style={{ color: i === stages.length - 1 ? ACCENT : TEXT }}>
          {s}
        </span>
        {i < stages.length - 1 && <span style={{ color: ACCENT }}>›</span>}
      </span>
    ))}
  </div>
)

const ProcessPanel: FC<{ proc: ProcessReadings }> = ({ proc }) => (
  <Card
    pos={{ top: 76, left: 16 }}
    width={248}
    title="Process Stack"
    headerRight={
      <span
        style={{
          fontFamily: SANS,
          fontSize: 10,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: GOOD
        }}
      >
        ● Live
      </span>
    }
  >
    <SplatPanelStageStrip
      stages={['BIOMASS', 'KILN', 'CARBOX', 'ARX', 'WAX']}
    />
    <Row label="Feedstock">
      <Mono>{proc.biomassTPerDay}</Mono>{' '}
      <span style={{ color: MUTED }}>t/day</span>
    </Row>
    <Row label="Caera wax">
      <Mono color={ACCENT}>{proc.waxKgPerDay.toLocaleString('en-US')}</Mono>{' '}
      <span style={{ color: MUTED }}>kg/day · {proc.waxTPerYear} t/yr</span>
    </Row>
    <Row label="Wax energy">
      <Mono>{proc.waxEnergyMWhPerDay}</Mono>{' '}
      <span style={{ color: MUTED }}>MWh/day</span>
    </Row>
    <Row label="Oxygen">
      <Mono>{proc.oxygenTPerYear.toLocaleString('en-US')}</Mono>{' '}
      <span style={{ color: MUTED }}>t/yr</span>
    </Row>
    <Row label="Biochar">
      <Mono>{proc.biocharTPerYear.toLocaleString('en-US')}</Mono>{' '}
      <span style={{ color: MUTED }}>t/yr</span>
    </Row>
    <Row label="Carbon → products">
      <Mono color={GOOD}>{proc.carbonToProductsPct}%</Mono>
    </Row>
    <Row label="CO₂ vented">
      <Mono color={GOOD}>{proc.co2VentedTPerYear} t/yr</Mono>{' '}
      <span style={{ color: GOOD, fontSize: 10 }}>· ZERO</span>
    </Row>
    <div
      style={{
        marginTop: 6,
        fontFamily: MONO,
        fontSize: 9.5,
        color: MUTED,
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      Kiln {proc.kilnTempC}° · Carbox {proc.carboxTempC}° · F-T {proc.ftTempC}°
    </div>
    <Footnote>{proc.stackName} · biomass→wax · closed-loop</Footnote>
  </Card>
)

// Minimal inline-SVG sparkline for the telemetry cards. Fixed to the card inner
// width (216 = 248 − 2×16 padding) so no aspect scaling is needed; themed with
// the card tokens. Area fill + line + a dot at the latest sample.
const Sparkline: FC<{ points: number[]; color?: string }> = ({
  points,
  color = ACCENT
}) => {
  const w = 216
  const h = 30
  const pad = 2
  if (points.length < 2) {
    return null
  }
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const x = (i: number): number =>
    pad + (i / (points.length - 1)) * (w - 2 * pad)
  const y = (v: number): number => pad + (1 - (v - min) / span) * (h - 2 * pad)
  const line = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const last = points.length - 1
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: 'block', margin: '1px 0 6px', maxWidth: '100%' }}
    >
      <polygon
        points={`${pad},${h - pad} ${line.join(' ')} ${w - pad},${h - pad}`}
        fill={color}
        opacity={0.12}
      />
      <polyline
        points={line.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
      />
      <circle cx={x(last)} cy={y(points[last])} r={2} fill={color} />
    </svg>
  )
}

// --- Arx F-T reactor telemetry (top-right; replaces weather at the plant) -----
// Live readout of the Arx Fischer-Tropsch reactor's operating point, sourced from
// the simulation engine's simulate_arx (huma-simulation-engine). The live MCP
// needs auth + a backend, so this random-walks (smooth incommensurate sines)
// around the sim's steady-state values for a running-telemetry feel.
const FtTelemetryCard: FC<{ proc: ProcessReadings }> = ({ proc }) => {
  const [t, setT] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setT(x => x + 1), 1500)
    return () => clearInterval(id)
  }, [])
  // Two incommensurate sines per channel → organic, bounded wobble (no RNG),
  // evaluated over the last N ticks so each channel is a live rolling series.
  const N = 32
  const wobAt = (tt: number, amp: number, phase: number): number =>
    amp * (Math.sin(tt * 0.7 + phase) * 0.6 + Math.sin(tt * 1.9 + phase * 2) * 0.4)
  const series = (base: number, amp: number, phase: number): number[] =>
    Array.from({ length: N }, (_, k) => base + wobAt(t - (N - 1) + k, amp, phase))
  const convSeries = series(proc.ftConversionPct, 0.6, 0)
  const waxSeries = series(proc.ftWaxRateKgH, 3.5, 2)
  const conv = convSeries[N - 1]
  const wax = waxSeries[N - 1]
  const ratio = proc.ftH2CoRatio + wobAt(t, 0.04, 1)
  const heat = proc.ftHeatDutyKw + wobAt(t, 7, 3)
  return (
    <Card
      pos={{ top: 60, right: 16 }}
      width={248}
      title="Arx F-T Reactor"
      headerRight={
        <span
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: GOOD
          }}
        >
          ● Running
        </span>
      }
    >
      <Row label="CO conversion">
        <Mono color={ACCENT}>{conv.toFixed(1)}%</Mono>{' '}
        <span style={{ color: MUTED }}>per pass</span>
      </Row>
      <Sparkline points={convSeries} />
      <Row label="Reactor temp">
        <Mono>{proc.ftTempC}</Mono> <span style={{ color: MUTED }}>°C</span>
      </Row>
      <Row label="H₂:CO feed">
        <Mono>{ratio.toFixed(2)}</Mono>
        <span style={{ color: MUTED }}>:1</span>
      </Row>
      <Row label="Chain growth α">
        <Mono>{proc.ftChainGrowthAlpha.toFixed(2)}</Mono>{' '}
        <span style={{ color: MUTED }}>ASF · wax</span>
      </Row>
      <Row label="Wax rate">
        <Mono color={ACCENT}>{wax.toFixed(0)}</Mono>{' '}
        <span style={{ color: MUTED }}>kg/h</span>
      </Row>
      <Sparkline points={waxSeries} color={GOOD} />
      <Row label="Heat duty">
        <Mono>{heat.toFixed(0)}</Mono>{' '}
        <span style={{ color: MUTED }}>kW · exotherm</span>
      </Row>
      <Footnote>Arx F-T · {proc.ftCatalyst} · live sim</Footnote>
    </Card>
  )
}

// --- bunkering inspector -----------------------------------------------------
// Generic labelled fill bar (fuel / battery): label + value readout above a
// proportional bar. `fill` is clamped to 0..1.
const MeterBar: FC<{
  label: string
  fill: number
  value: string
  color?: string
}> = ({ label, fill, value, color = ACCENT }) => (
  <div
    style={{
      padding: '6px 0',
      borderTop: '1px solid rgba(255,255,255,0.06)'
    }}
  >
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 5
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
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          color: TEXT
        }}
      >
        {value}
      </span>
    </div>
    <div
      style={{
        position: 'relative',
        height: 8,
        background: 'rgba(255,255,255,0.08)',
        border: PANEL_BORDER
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${Math.min(Math.max(fill, 0), 1) * 100}%`,
          background: color,
          transition: 'width .2s linear'
        }}
      />
    </div>
  </div>
)

// Two-vessel readout for the bunkering scenario: the wax carrier's solid-cube
// cargo transfer (cube count + crane rate) and the substation vessel's battery
// + grid export. Transfer/battery figures are static demo values (footnoted);
// the collected power is the LIVE modelled farm output (count × per-turbine),
// so it reacts to the forecast wind / time scrubber. Export = collected − the
// battery draw, floored at 0.
const BunkeringPanel: FC<{
  readings: BunkeringReadings
  telemetry: TurbineTelemetry
  count: number
}> = ({ readings, telemetry, count }) => {
  const collectedMW =
    telemetry.powerMW == null ? null : telemetry.powerMW * count
  const exportMW =
    collectedMW == null
      ? null
      : Math.max(0, collectedMW - readings.batteryChargeMW)
  return (
    <Card
      pos={{ top: 76, left: 16 }}
      width={248}
      title="Bunkering"
      headerRight={
        <span
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: GOOD
          }}
        >
          Transfer
        </span>
      }
    >
      <SectionLabel>Wax carrier</SectionLabel>
      <MeterBar
        label="Cargo"
        fill={
          readings.cubesTotal > 0
            ? readings.cubesTransferred / readings.cubesTotal
            : 0
        }
        value={`${Math.round(readings.cubesTransferred)} / ${Math.round(
          readings.cubesTotal
        )} cubes`}
      />
      <Row label="Transfer">{fmt(readings.transferRateCubesH, 'cubes/h', 0)}</Row>
      <Row label="Cube">{`${readings.cubeVolumeM3} m³ · ${readings.cubeMassT} t`}</Row>
      <Row label="Product">{readings.product}</Row>
      <SectionLabel>Substation vessel</SectionLabel>
      <Row label={`Collected · ${count}×`}>
        {collectedMW == null ? '—' : `${collectedMW.toFixed(1)} MW`}
      </Row>
      <MeterBar
        label="Battery"
        fill={readings.batterySoc}
        value={`${Math.round(readings.batterySoc * 100)}% · ${fmt(
          readings.batteryCapacityMWh,
          'MWh',
          0
        )}`}
        color={GOOD}
      />
      <Row label="Charging">{fmt(readings.batteryChargeMW, 'MW', 1)}</Row>
      <Row label="Export">
        {exportMW == null ? '—' : `${exportMW.toFixed(1)} MW`}
      </Row>
      <Row label="DC bus">{fmt(readings.busKv, 'kV', 0)}</Row>
      <Footnote>
        Transfer &amp; battery: static demo · collected power modelled from
        forecast wind
      </Footnote>
    </Card>
  )
}

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
    <Card
      pos={{ bottom: 20, left: '50%' }}
      width="min(620px, 86vw)"
      title="Forecast time"
      interactive
      style={{ transform: 'translateX(-50%)' }}
      headerRight={
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
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ position: 'relative', flex: 1 }}>
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
            cursor: 'pointer',
            flexShrink: 0
          }}
        >
          Now
        </button>
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
    </Card>
  )
}

// --- camera controls panel ---------------------------------------------------
export type CameraMode = 'orbit' | 'fps'

export interface CameraControlsState {
  mode: CameraMode
  onMode: (mode: CameraMode) => void
  autoRotate: boolean
  onAutoRotate: (v: boolean) => void
  zoom: number
  zoomMin: number
  zoomMax: number
  onZoom: (v: number) => void
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
  mode,
  onMode,
  autoRotate,
  onAutoRotate,
  zoom,
  zoomMin,
  zoomMax,
  onZoom
}) => (
  <Card pos={{ bottom: 16, left: 16 }} width={220} title="Camera" interactive gap={10}>
    {/* View mode switch */}
    <div style={{ display: 'flex', gap: 6 }}>
      {(
        [
          ['orbit', 'Orbit'],
          ['fps', 'First person']
        ] as const
      ).map(([value, label]) => {
        const active = mode === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => onMode(value)}
            style={{ flex: 1, padding: '5px 9px', fontSize: 11, ...pillStyle(active) }}
          >
            {label}
          </button>
        )
      })}
    </div>

    {mode === 'fps' ? (
      <div
        style={{
          fontFamily: SANS,
          fontSize: 10,
          lineHeight: 1.6,
          letterSpacing: '0.04em',
          color: MUTED
        }}
      >
        WASD move · drag to look
        <br />
        Space / C up / down · Shift fast
      </div>
    ) : (
      <OrbitControlsBody
        autoRotate={autoRotate}
        onAutoRotate={onAutoRotate}
        zoom={zoom}
        zoomMin={zoomMin}
        zoomMax={zoomMax}
        onZoom={onZoom}
      />
    )}
  </Card>
)

// Human-readable distance: metres under 1 km, then km (planetary range spans
// metres → tens of thousands of km, so a fixed unit reads badly at one end).
const fmtDistance = (m: number): string =>
  m < 1000
    ? `${Math.round(m)} m`
    : m < 100_000
      ? `${(m / 1000).toFixed(1)} km`
      : `${Math.round(m / 1000).toLocaleString()} km`

// Orbit-mode body of the camera card: zoom slider + auto-rotate toggle.
// The slider is LOGARITHMIC: orbit distance spans ~7 orders of magnitude (a few
// metres on a deck → planetary full-disk), so a linear slider would make the
// near range unusable. t in [0,1] maps to distance = min·(max/min)^(1−t), and
// is inverted so dragging right zooms IN (smaller distance), matching feel.
const OrbitControlsBody: FC<{
  autoRotate: boolean
  onAutoRotate: (v: boolean) => void
  zoom: number
  zoomMin: number
  zoomMax: number
  onZoom: (v: number) => void
}> = ({ autoRotate, onAutoRotate, zoom, zoomMin, zoomMax, onZoom }) => {
  const ratio = Math.log(zoomMax / zoomMin)
  // distance → slider position (0 = farthest/left, 1 = closest/right)
  const clamped = Math.min(Math.max(zoom, zoomMin), zoomMax)
  const t = 1 - Math.log(clamped / zoomMin) / ratio
  const fromT = (v: number): number => zoomMin * Math.exp((1 - v) * ratio)
  return (
    <>
      {/* Zoom puller (log-scaled) */}
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
            {fmtDistance(zoom)}
          </span>
        </div>
        <input
          className="dt-scrub"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={t}
          onChange={e => onZoom(fromT(Number(e.target.value)))}
          style={{ width: '100%', display: 'block' }}
        />
      </div>

      <Toggle label="Auto-rotate" on={autoRotate} onChange={onAutoRotate} />
    </>
  )
}

// --- scenario panel ----------------------------------------------------------
export interface ScenarioSettingControl {
  label: string
  on: boolean
  onChange: (v: boolean) => void
}

export interface ScenarioControlsState {
  scenarios: Scenario[]
  activeScenario: string | null // Scenario.id
  activeViewpoint: string | null // Viewpoint.id within the active scenario
  onSelect: (scenario: Scenario, viewpoint: Viewpoint) => void
  // Registry the scenarios' `settings` ids resolve against (host-owned state).
  settings?: Record<string, ScenarioSettingControl>
}

// Accordion: exactly one scenario (the active one) shows its viewpoint chips
// and setting toggles. Clicking a scenario row flies to its first viewpoint;
// chips fly to specific viewpoints. Selection state lives in App (it also
// drives the FPS spawn on scenario switches).
const ScenarioPanel: FC<ScenarioControlsState> = ({
  scenarios,
  activeScenario,
  activeViewpoint,
  onSelect,
  settings
}) => (
  <Card
    pos={{ bottom: 16, right: 16 }}
    width={232}
    title="Scenarios"
    interactive
    gap={6}
  >
    {scenarios.map(scenario => {
      const active = scenario.id === activeScenario
      return (
        <div key={scenario.id}>
          <button
            type="button"
            onClick={() => onSelect(scenario, scenario.viewpoints[0])}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              width: '100%',
              gap: 10,
              padding: '6px 8px',
              fontSize: 11,
              ...pillStyle(active)
            }}
          >
            {scenario.label}
            <ChevronIcon open={active} />
          </button>
          {active && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                padding: '6px 0 2px 12px'
              }}
            >
              {scenario.viewpoints.map(viewpoint => {
                const vpActive = viewpoint.id === activeViewpoint
                return (
                  <button
                    key={viewpoint.id}
                    type="button"
                    onClick={() => onSelect(scenario, viewpoint)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '4px 8px',
                      fontSize: 10,
                      ...pillStyle(vpActive)
                    }}
                  >
                    <PinIcon />
                    {viewpoint.label}
                  </button>
                )
              })}
            </div>
          )}
          {/* Per-scenario setting toggles (e.g. wind farm rotor spin/cover) */}
          {active && scenario.settings != null && settings != null && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '0 0 2px 12px'
              }}
            >
              {scenario.settings.map(id => {
                const setting = settings[id]
                if (setting == null) return null
                return (
                  <Toggle
                    key={id}
                    label={setting.label}
                    on={setting.on}
                    onChange={setting.onChange}
                  />
                )
              })}
            </div>
          )}
        </div>
      )
    })}
  </Card>
)

// --- shadow-fleet vessel callout ---------------------------------------------
// All info we can surface for one clicked globe marker: live AIS (BarentsWatch
// Full model) merged with the EU sanctions metadata. Every field optional —
// rendered only when the feed actually supplied it (never fabricated).
export interface SelectedVessel extends VesselPosition {
  // Which globe layer this vessel came from — drives the banner + footnote.
  // 'shadow' = EU-sanctioned (sanctions metadata below); 'patrol' = Norwegian
  // Coast Guard / Navy (no sanctions metadata).
  category: 'shadow' | 'patrol'
  // From the EU sanctions dataset (shadowFleet.ts); null for patrol vessels:
  formerly: string | null
  groundLabel: string | null
  listed: string | null
}

// AIS navigational-status codes (ITU-R M.1371) → text.
const NAV_STATUS: Record<number, string> = {
  0: 'Under way using engine',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted manoeuvrability',
  4: 'Constrained by draught',
  5: 'Moored',
  6: 'Aground',
  7: 'Engaged in fishing',
  8: 'Under way sailing',
  15: 'Undefined'
}
// AIS ship-type code → coarse class (first digit buckets the 0–99 range).
const shipTypeLabel = (code: number | null): string => {
  if (code == null) return '—'
  if (code >= 80 && code <= 89) return `Tanker (${code})`
  if (code >= 70 && code <= 79) return `Cargo (${code})`
  if (code >= 60 && code <= 69) return `Passenger (${code})`
  if (code >= 40 && code <= 49) return `High-speed craft (${code})`
  if (code === 30) return 'Fishing'
  if (code === 35) return 'Military'
  if (code === 36) return 'Sailing'
  if (code === 37) return 'Pleasure craft'
  if (code === 50) return 'Pilot'
  if (code === 52) return 'Tug'
  if (code === 55) return 'Law enforcement'
  return `Type ${code}`
}
const fmtClock = (iso: string | null): string =>
  iso == null
    ? '—'
    : new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })

const VesselCallout: FC<{
  vessel: SelectedVessel
  onClose: () => void
}> = ({ vessel: v, onClose }) => {
  const moving = v.speedOverGround != null && v.speedOverGround >= 0.5
  return (
    <div
      style={{
        // Top-left inspector slot (clear of the centred ship); replaces the
        // turbine card while a vessel is selected.
        ...cardStyle({ top: 60, left: 16 }, 320),
        pointerEvents: 'auto',
        maxHeight: 'calc(100vh - 120px)',
        overflowY: 'auto'
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 10,
          marginBottom: 8
        }}
      >
        <span
          style={{
            fontFamily: SANS,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '0.02em',
            color: TEXT
          }}
        >
          {v.name ?? `IMO ${v.imo}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            fontFamily: SANS,
            fontSize: 14,
            lineHeight: 1,
            color: MUTED,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0
          }}
        >
          ✕
        </button>
      </div>

      {/* Category banner — why the vessel is tracked. Red for sanctioned shadow
          fleet, blue for Coast Guard / Navy patrol. */}
      <div
        style={{
          fontFamily: SANS,
          fontSize: 10,
          letterSpacing: '0.04em',
          color: v.category === 'patrol' ? PATROL_ACCENT : ACCENT,
          textTransform: 'uppercase',
          marginBottom: 8
        }}
      >
        {v.category === 'patrol'
          ? 'Norwegian Coast Guard / Navy'
          : `EU sanctioned${v.listed != null ? ` · listed ${v.listed}` : ''}`}
      </div>

      {v.groundLabel != null && (
        <Row label="Grounds">
          <span style={{ fontFamily: SANS, fontSize: 11, color: TEXT }}>
            {v.groundLabel}
          </span>
        </Row>
      )}
      {v.formerly != null && <Row label="Ex-name">{v.formerly}</Row>}

      <Row label="Status">
        <span style={{ color: moving ? GOOD : MUTED }}>
          {v.navigationalStatus != null
            ? (NAV_STATUS[v.navigationalStatus] ??
              `Code ${v.navigationalStatus}`)
            : '—'}
        </span>
      </Row>
      <Row label="IMO">{v.imo ?? '—'}</Row>
      <Row label="MMSI">{v.mmsi ?? '—'}</Row>
      <Row label="Call sign">{v.callSign ?? '—'}</Row>
      <Row label="Type">{shipTypeLabel(v.shipType)}</Row>
      <Row label="Destination">{v.destination ?? '—'}</Row>
      <Row label="ETA">{v.eta ?? '—'}</Row>
      <Row label="Speed">{fmt(v.speedOverGround, 'kn', 1)}</Row>
      <Row label="Course">
        <span style={{ color: MUTED }}>{fmtDir(v.courseOverGround)}</span>
      </Row>
      <Row label="Heading">
        <span style={{ color: MUTED }}>{fmtDir(v.trueHeading)}</span>
      </Row>
      <Row label="Rate of turn">{fmt(v.rateOfTurn, '°/min', 0)}</Row>
      <Row label="Size">
        {v.shipLength != null && v.shipWidth != null
          ? `${Math.round(v.shipLength)} × ${Math.round(v.shipWidth)} m`
          : '—'}
      </Row>
      <Row label="Draught">{fmt(v.draught, 'm', 1)}</Row>
      <Row label="Position">
        <span style={{ fontSize: 11 }}>
          {v.latitude.toFixed(3)}, {v.longitude.toFixed(3)}
        </span>
      </Row>
      <Row label="AIS fix">{fmtClock(v.msgtime)}</Row>

      {/* Link-out to the public vessel page (photo + registry). We can't embed
          those photos (provider ToS / no free image API), so a one-click link is
          the honest path. Key off IMO when broadcast, else MMSI (patrol vessels
          often omit IMO); hidden only if the vessel has neither. */}
      {(() => {
        const key =
          v.imo != null ? `imo:${v.imo}` : v.mmsi != null ? `mmsi:${v.mmsi}` : null
        if (key == null) return null
        const links: Array<[string, string]> = [
          ['Photo & registry', `https://www.marinetraffic.com/en/ais/details/ships/${key}`],
          [
            'VesselFinder',
            v.imo != null
              ? `https://www.vesselfinder.com/?imo=${v.imo}`
              : `https://www.vesselfinder.com/?mmsi=${v.mmsi}`
          ]
        ]
        return (
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {links.map(([label, href]) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  flex: 1,
                  textAlign: 'center',
                  padding: '5px 8px',
                  fontFamily: SANS,
                  fontSize: 10,
                  letterSpacing: '0.04em',
                  color: TEXT,
                  textDecoration: 'none',
                  background: 'rgba(255,255,255,0.06)',
                  border: PANEL_BORDER,
                  borderRadius: 0
                }}
              >
                {label} ↗
              </a>
            ))}
          </div>
        )
      })()}
      <Footnote>
        {v.category === 'patrol'
          ? 'AIS: BarentsWatch · KV/Coast Guard identified by call-sign/ship-type; warships often run AIS-dark'
          : 'AIS: BarentsWatch · sanctions: EU Reg 833/2014 Annex XLII'}
      </Footnote>
    </div>
  )
}

// --- composition (presentational) -------------------------------------------
// --- installation rig panel --------------------------------------------------
export interface InstallControlsState {
  activeClip: string // current rig clip name
  speed: number // playback timeScale
  playingSequence: boolean
  onSelectPhase: (clip: string) => void
  onSetSpeed: (speed: number) => void
  onPlaySequence: () => void
}

// One load gauge: label + colour-coded fill bar (load / SWL) + tonnage readout.
const LoadGauge: FC<{ label: string; load: number; swl: number }> = ({
  label,
  load,
  swl
}) => {
  const ratio = swl > 0 ? load / swl : 0
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}
    >
      <span
        style={{ fontFamily: MONO, fontSize: 10, color: MUTED, width: 22 }}
      >
        {label}
      </span>
      <div
        style={{
          position: 'relative',
          flex: 1,
          height: 9,
          background: 'rgba(255,255,255,0.08)',
          border: PANEL_BORDER
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${Math.min(Math.max(ratio, 0), 1) * 100}%`,
            background: loadColor(ratio),
            transition: 'width .12s linear, background .2s linear'
          }}
        />
      </div>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 11,
          fontVariantNumeric: 'tabular-nums',
          color: TEXT,
          width: 42,
          textAlign: 'right'
        }}
      >
        {load >= 1 ? Math.round(load) : load.toFixed(1)} t
      </span>
    </div>
  )
}

// Installation control panel (turbine-install scenario): the 10 install-phase
// buttons + play-sequence/idle/speed, the active phase narrative, and the
// winch/beam-ram/guy-ram load gauges. Ports the original viewer's HUD into one
// Card; occupies the top-left inspector slot (no turbine farm at the rig site).
const InstallationPanel: FC<InstallControlsState> = ({
  activeClip,
  speed,
  playingSequence,
  onSelectPhase,
  onSetSpeed,
  onPlaySequence
}) => {
  const phase = RIG_PHASES[activeClip] ?? RIG_PHASES[IDLE_CLIP]
  return (
    <Card
      pos={{ top: 76, left: 16 }}
      width={252}
      title="Installation"
      interactive
      gap={10}
      headerRight={
        <span
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: ACCENT
          }}
        >
          {phase.label}
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {PHASE_CLIPS.map((clip, i) => (
          <button
            key={clip}
            type="button"
            onClick={() => onSelectPhase(clip)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '4px 8px',
              fontSize: 11,
              ...pillStyle(clip === activeClip)
            }}
          >
            <span style={{ fontFamily: MONO, color: MUTED, width: 16 }}>
              {i + 1}
            </span>
            <span style={{ fontFamily: SANS }}>{RIG_PHASES[clip].label}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onPlaySequence}
        style={{
          width: '100%',
          padding: '5px 8px',
          fontSize: 11,
          ...pillStyle(playingSequence)
        }}
      >
        {playingSequence ? 'Playing…' : 'Play sequence'}
      </button>
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: MUTED,
            marginBottom: 4
          }}
        >
          <span>Speed</span>
          <span style={{ fontFamily: MONO }}>{speed.toFixed(2)}×</span>
        </div>
        <input
          className="dt-scrub"
          type="range"
          min={0.25}
          max={3}
          step={0.05}
          value={speed}
          onChange={e => onSetSpeed(Number(e.target.value))}
          style={{ width: '100%', display: 'block' }}
        />
      </div>
      <div style={{ fontFamily: SANS, fontSize: 11, color: TEXT, lineHeight: 1.4 }}>
        {phase.narrative}
        <div style={{ marginTop: 3, fontSize: 10, color: MUTED }}>
          {phase.capability}
        </div>
      </div>
      <div>
        <SectionLabel>{`Winch ×3 · SWL ${WINCH_SWL} t/drum`}</SectionLabel>
        {phase.winch.map((load, i) => (
          <LoadGauge key={`w${i}`} label={`${i + 1}`} load={load} swl={WINCH_SWL} />
        ))}
        <div style={{ marginTop: 7 }}>
          <SectionLabel>{`Beam rams ×3 · SWL ${RAM_SWL} t`}</SectionLabel>
        </div>
        {phase.beam.map((load, i) => (
          <LoadGauge key={`r${i}`} label={`R${i + 1}`} load={load} swl={RAM_SWL} />
        ))}
        <div style={{ marginTop: 7 }}>
          <SectionLabel>{`Guy ram · SWL ${RAM_SWL} t`}</SectionLabel>
        </div>
        <LoadGauge label="G" load={phase.guy} swl={RAM_SWL} />
      </div>
    </Card>
  )
}

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
  scenarioControls?: ScenarioControlsState
  // AIS readings of the active scenario's vessel; replaces the turbine
  // inspector when present.
  ais?: AisReadings | null
  // Two-vessel metrics for the bunkering scenario; takes the inspector slot.
  bunkering?: BunkeringReadings | null
  // Gaussian-splat capture stats; takes the inspector slot (geospatial scenario).
  splat?: SplatReadings | null
  // Process-stack telemetry; takes the inspector slot (waste-handling scenario).
  process?: ProcessReadings | null
  // Clicked shadow-fleet vessel (globe markers) → full callout. null = closed.
  selectedVessel?: SelectedVessel | null
  onCloseVessel?: () => void
  // AIS marker-layer toggles + counts. Replaces the conditions card at the
  // globe-overview altitude (where point weather is meaningless).
  aisLayers?: AisLayersState | null
  // Installation-rig controls (turbine-install scenario). When present, the
  // Installation panel takes the top-left inspector slot.
  installControls?: InstallControlsState | null
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
  cameraControls,
  scenarioControls,
  ais,
  bunkering,
  splat,
  process,
  selectedVessel,
  onCloseVessel,
  aisLayers,
  installControls
}) => {
  // The top-left inspector slot shows, in priority: the clicked shadow-fleet
  // vessel callout → the scenario's AIS card → the bunkering two-vessel panel →
  // the installation panel (rig scenario) → the turbine inspector.
  return (
  <>
    {selectedVessel != null && onCloseVessel != null ? (
      <VesselCallout vessel={selectedVessel} onClose={onCloseVessel} />
    ) : ais != null ? (
      <AisCard ais={ais} />
    ) : bunkering != null ? (
      <BunkeringPanel
        readings={bunkering}
        telemetry={telemetry}
        count={turbineCount}
      />
    ) : installControls != null ? (
      <InstallationPanel {...installControls} />
    ) : splat != null ? (
      <SplatPanel splat={splat} />
    ) : process != null ? (
      <ProcessPanel proc={process} />
    ) : (
      <TurbineInspector telemetry={telemetry} count={turbineCount} />
    )}
    {aisLayers != null && aisLayers.overview ? (
      <AisLayersCard {...aisLayers} />
    ) : process != null ? (
      <FtTelemetryCard proc={process} />
    ) : (
      <ConditionsCard
        locationName={locationName}
        sample={sample}
        loading={loading}
        error={error}
      />
    )}
    {cameraControls != null && <ControlsPanel {...cameraControls} />}
    {scenarioControls != null && <ScenarioPanel {...scenarioControls} />}
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
}
