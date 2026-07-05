// Canonical site/scenario/tour data model for the twin, taken verbatim from
// plans/2026-06-23-gravis-earthworks-site-scenario-authoring-plan.md (Phase 1).
// A SiteDefinition anchors layers/scenarios/annotations/tours in a local ENU
// frame under a WGS84 anchor. Pure types, no imports — shared by the client
// runtime, the author tooling, and the server-side site manifest store.

export interface SiteDefinition {
  id: string
  label: string
  description?: string
  anchor: SiteAnchor
  layers: SiteLayer[]
  scenarios: SiteScenario[]
  annotations: SiteAnnotation[]
  tours?: SiteTour[]
  panels?: SitePanelDefinition[]
}

export interface SiteAnchor {
  longitude: number
  latitude: number
  height?: number
  frame: 'wgs84-enu'
}

export type SiteLayer =
  | SiteModelLayer
  | SiteSplatLayer
  | SiteTilesetLayer
  | SiteTelemetryLayer
  | SiteDesignSurfaceLayer

export interface SiteModelLayer {
  type: 'model'
  id: string
  label: string
  url: string
  transform: SiteTransform
  visibleByDefault?: boolean
  scenarioIds?: string[]
}

export interface SiteSplatLayer {
  type: 'splat'
  id: string
  label: string
  url: string
  format: 'ply' | 'spz' | 'sog' | 'ksplat' | '3dtiles'
  transform: SiteTransform
  capture?: {
    capturedAt?: string
    source?: 'drone' | 'phone' | 'lidar' | 'synthetic' | 'unknown'
    accuracyNote?: string
  }
  visibleByDefault?: boolean
  scenarioIds?: string[]
}

export interface SiteTilesetLayer {
  type: 'tileset'
  id: string
  label: string
  url: string
  transform: SiteTransform
  visibleByDefault?: boolean
  scenarioIds?: string[]
}

export interface SiteTelemetryLayer {
  type: 'telemetry'
  id: string
  label: string
  // Same-origin feed the runtime polls/subscribes for this layer's data.
  sourceUrl: string
  transform: SiteTransform
  visibleByDefault?: boolean
  scenarioIds?: string[]
}

export interface SiteDesignSurfaceLayer {
  type: 'design-surface'
  id: string
  label: string
  url: string
  transform: SiteTransform
  visibleByDefault?: boolean
  scenarioIds?: string[]
}

// Placement in the site's local ENU frame (metres east/north/up from the
// anchor). Rotation as either euler degrees (applied about the ENU east/
// north/up axes, XYZ order) or an explicit quaternion in the same frame.
export interface SiteTransform {
  positionENU: [number, number, number]
  rotationEulerDeg?: [number, number, number]
  quaternion?: [number, number, number, number]
  scale?: number | [number, number, number]
}

// Pins time-of-day and/or suppresses live weather for a scenario — for
// enclosed/indoor sites where neither applies (or would look wrong). Omit a
// field to keep following the live/scrubbed timeline or live MET for it.
// The host eases into and out of an override rather than snapping.
export interface ScenarioEnvironment {
  // Fixed local hour (0-23, may be fractional) the sun/sky is pinned to.
  timeOfDayHour?: number
  // Ignore live MET (wind/wave/precipitation/air temperature) entirely.
  ignoreWeather?: boolean
}

export interface SiteScenario {
  id: string
  label: string
  summary?: string
  defaultViewpointId?: string
  layerOverrides?: Record<string, { visible?: boolean; opacity?: number }>
  settings?: SiteSettingDefinition[]
  // Authored environment override. On a static (code-owned) scenario this
  // replaces its code default; `null` explicitly clears back to that
  // default (vs. omitting the field, which just means "never touched").
  environment?: ScenarioEnvironment | null
  // Publish state — false hides this scenario from visitors (stripped
  // server-side, not just client-filtered). Omitted/true = live. Only
  // meaningful for authored scenarios; static (code-owned) ones are always
  // live.
  enabled?: boolean
  viewpoints: SiteViewpoint[]
  panelIds?: string[]
  annotationIds?: string[]
  tourIds?: string[]
}

export interface SiteViewpoint {
  id: string
  label: string
  targetENU: [number, number, number]
  distance?: number
  headingDeg?: number
  pitchDeg?: number
  cameraENU?: [number, number, number]
  fovDeg?: number
}

export interface SiteAnnotation {
  id: string
  label: string
  body?: string
  layerId?: string
  scenarioIds?: string[]
  positionENU: [number, number, number]
  icon?: string
  severity?: 'info' | 'warning' | 'critical' | 'success'
  tags?: string[]
  view?: {
    targetENU: [number, number, number]
    cameraENU?: [number, number, number]
    distance?: number
    headingDeg?: number
    pitchDeg?: number
  }
}

export interface SiteTour {
  id: string
  label: string
  description?: string
  durationSec?: number
  path: SerializedEnuBezierPath
  stops: TourStop[]
  audio?: TourAudioTrack
}

export interface TourStop {
  id: string
  timeSec: number
  title: string
  body?: string
  annotationId?: string
  layerOverrides?: Record<string, { visible?: boolean; opacity?: number }>
  pause?: boolean
  // Per-stop audio clip (simple nontechnical authoring), alternative to the
  // tour-level continuous track.
  audioUrl?: string
  autoAdvanceAfterAudio?: boolean
}

export interface TourAudioTrack {
  url: string
  transcript?: Array<{
    startSec: number
    endSec: number
    text: string
  }>
}

// Camera rail for a tour, structurally matching @huma/path-creator's
// SerializedBezierPath (BezierPath.toJSON()) with all coordinates in site ENU
// metres. Declared locally because path-creator consumption is deferred until
// the tour-runtime phase — when it lands, BezierPath.fromJSON() consumes this
// shape directly after the ENU→world conversion.
export interface SerializedEnuBezierPath {
  points: Array<{ x: number; y: number; z: number }>
  perAnchorNormalsAngle: number[]
  isClosed: boolean
  // PathSpace / ControlMode enum values from path-creator, kept numeric here.
  space: number
  controlMode: number
  autoControlLength: number
  flipNormals: boolean
  globalNormalsAngle: number
}

// Contextual DOM panel a site/scenario can request (conditions, telemetry,
// AIS, progress, ...). Resolves against the host app's panel registry.
export interface SitePanelDefinition {
  id: string
  label: string
}

// Per-scenario setting toggle; resolves against the host app's registry of
// host-owned controls (e.g. rotor spin, hero cover).
export interface SiteSettingDefinition {
  id: string
  label: string
  defaultOn?: boolean
}
