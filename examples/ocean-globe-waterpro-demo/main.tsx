// Standalone deployment entry for the Globe WaterPro Ocean story.
// Mounts the storybook story's Content component inside a fullscreen
// react-three-fiber Canvas backed by WebGPURenderer — no Storybook chrome,
// no 85vw side panel. Holds a loading splash over the canvas until the
// atmosphere LUT compute and ocean chunk-builder pool both report ready;
// no fixed timer, no hope-based reveal. Also renders the digital-twin DOM
// overlay siblings: the top-left Huma brand mark (BrandMark, ported from the
// humatopia-frontend sidebar), the live MET conditions HUD + forecast scrubber
// + camera/scenario panels (DigitalTwinUI, fed by the active scene location),
// and a collapsed Leva debug panel.

// requestIdleCallback shim — MUST be the first import. The atmosphere package
// (AtmosphereLUTNode -> helpers/requestIdleCallback) drives its multi-stage LUT
// compute via requestIdleCallback, and that helper captures
// window.requestIdleCallback into a module-level const the first time it
// evaluates. Under the twin's heavy WebGPU render loop Chrome starves the
// native idle callback, so the LUT precompute hangs ("Precomputing atmosphere").
// The shim must therefore be installed BEFORE any atmosphere code evaluates —
// an inline shim here would be too late, because ES module imports are hoisted
// and evaluated before this module's own body runs. Keeping it as the first
// import guarantees its module body wins the capture. See installIdleCallbackShim.ts.
import './installIdleCallbackShim'

import { Canvas, useThree } from '@react-three/fiber'
import { Leva } from 'leva'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC
} from 'react'
import { createRoot } from 'react-dom/client'
import { NoToneMapping, SRGBColorSpace } from 'three'
import { WebGPURenderer, type Renderer } from 'three/webgpu'

import {
  DigitalTwinUI,
  type CameraControlsState,
  type CameraMode,
  type InstallControlsState,
  type ScenarioControlsState,
  type SelectedVessel
} from './ui/DigitalTwinUI'
import { SCENARIOS, type Scenario, type Viewpoint } from './ui/scenarios'
import { INSTALL_CLIPS, IDLE_CLIP } from './ui/rigPhases'
import {
  SHADOW_FLEET,
  SHADOW_FLEET_GROUND_LABEL
} from './ui/shadowFleet'
import { modelTurbine } from './ui/turbineModel'
import { useMetForecast } from './ui/useMetForecast'
import {
  useShadowFleetAis,
  type ShadowFleetPosition
} from './ui/useShadowFleetAis'
import { useVesselTrack } from './ui/useVesselTrack'

// IMO → EU sanctions metadata, for merging into a clicked vessel's callout.
const SHADOW_FLEET_BY_IMO = new Map(SHADOW_FLEET.map(v => [v.imo, v]))

// Stable empty marker list for a hidden layer (referential identity, so the
// scene's memo doesn't churn each render).
const NO_VESSELS: VesselMarker[] = []

// Live AIS record → globe marker (position + heading + speed for the overlay).
const toMarker = (p: ShadowFleetPosition): VesselMarker => ({
  id: p.id,
  imo: p.imo,
  name: p.name,
  latitude: p.latitude,
  longitude: p.longitude,
  courseOverGround: p.courseOverGround,
  speedOverGround: p.speedOverGround
})

import {
  AtmosphereLight,
  AtmosphereLightNode
} from '@takram/three-atmosphere/webgpu'

import {
  Content,
  locationPresets,
  type ContentReadinessRefs,
  type SelectedVesselNav,
  type VesselMarker
} from '../../storybook-webgpu/src/ocean/GlobeWaterproOcean-Story'

const rootElement = document.getElementById('root')
const unsupportedElement = document.getElementById('unsupported')

const ZOOM_MIN = 5
// Up to planetary full-disk (~25,000 km altitude shows the whole globe). The
// camera panel's zoom slider is log-scaled, so the metre-scale near range stays
// usable across this span. Must stay ≤ the story's OrbitControls maxDistance.
const ZOOM_MAX = 30_000_000

// "Inspect a vessel" camera preset: top-down + north-up (matching the
// BarentsWatch viewpoint), zoomed in close to the clicked ship. 30 km keeps the
// orbit distance above the marker/AIS-panel hysteresis band (so the marker stays
// shown and the AIS panel stays up while you inspect), with the vessel and its
// near track/projection framed.
const VESSEL_FOCUS_DISTANCE = 30_000 // m orbit distance (≈30 km)
const VESSEL_FOCUS_HEADING = 90 // north-up: PointOfView measures heading from EAST
const VESSEL_FOCUS_PITCH = -82.5 // near-vertical top-down, as BarentsWatch

// First-person spawn pose for a viewpoint: its declared spawn, or — when none
// is declared — derived from the viewpoint itself (its lon/lat at ~eye level,
// or its camera aim offset from the scenario anchor). Platform spawns ('ship')
// resolve against the live deck frame scene-side; lon/lat are still passed as
// the geodetic fallback context.
function spawnFor(
  scenario: Scenario,
  viewpoint: Viewpoint
): {
  longitude: number
  latitude: number
  height?: number
  offsetENU?: [number, number, number]
  platform?: string
  headingDeg?: number
  pitchDeg?: number
  snapToSea?: boolean
} | null {
  const anchor =
    scenario.preset != null
      ? locationPresets[scenario.preset as keyof typeof locationPresets]
      : null
  const spawn = viewpoint.spawn
  const longitude =
    spawn?.longitude ?? viewpoint.longitude ?? anchor?.longitude
  const latitude = spawn?.latitude ?? viewpoint.latitude ?? anchor?.latitude
  if (longitude == null || latitude == null) return null
  // FPS spawn is a STANDING position, not camera framing. Never inherit the
  // viewpoint's aimOffsetENU (a camera-aim offset whose up-component floats the
  // player). With no explicit spawn, stand at the viewpoint's height (≈ terrain
  // for land sites). Sea scenarios start at the anchor and are lifted to the
  // ocean surface scene-side (snapToSea) — spawnFor can't see seaLevelOffset.
  const offsetENU = spawn?.offsetENU
  return {
    longitude,
    latitude,
    height:
      spawn?.height ??
      (spawn?.platform != null
        ? anchor?.height
        : (viewpoint.height ?? anchor?.height ?? 20) + 2),
    offsetENU,
    platform: spawn?.platform,
    headingDeg: spawn?.headingDeg ?? viewpoint.headingDeg,
    pitchDeg: spawn?.pitchDeg,
    // Sea scenarios (preset) with no explicit spawn: lift to the ocean surface
    // in-scene. Explicit spawns (incl. the deliberate underwater dive) opt out.
    snapToSea: scenario.preset != null && spawn == null
  }
}

if (rootElement == null) {
  throw new Error('Root element not found')
}

async function detectWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.gpu == null) return false
  try {
    return (await navigator.gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

// Two-phase readiness orchestration:
//
//   Phase 'atmosphere': Ocean is NOT mounted. The atmosphere LUT compute
//     pipeline runs without GPU contention from ocean chunk-builder workers
//     or the IFFT wave simulation. We poll lutNode.currentVersion +
//     lutNode.updating to detect completion.
//
//   Phase 'ocean': LUTs are done. Mount the ocean. Poll the OceanChunkManager
//     until the worker pool has actually delivered chunks (chunks_ dict has
//     entries AND builder.Busy === false). The atmosphere keeps rendering
//     against its stable LUTs while the ocean spins up.
//
//   Phase 'ready': both reported done. Splash fades.
//
// Two stalled-state safety nets, each scoped to its own phase, so a stuck
// atmosphere can't disguise itself as a stuck ocean (and vice versa).
type Phase = 'atmosphere' | 'ocean' | 'ready'

// Stability debounce: require the readiness condition to hold for this many
// consecutive frames before reporting. Then wait one additional rAF tick so
// the first render-after-ready completes (gives WebGPU shader/material
// compilation a frame to finish — chunks have geometry once Busy=false but
// the pipeline compiles on first draw). 5 frames at 60 Hz is ~83 ms.
const STABLE_FRAMES = 5

const ReadinessProbe: FC<{
  refs: ContentReadinessRefs | null
  phase: Phase
  onAtmosphereReady: (elapsedMs: number) => void
  onOceanReady: (elapsedMs: number) => void
}> = ({ refs, phase, onAtmosphereReady, onOceanReady }) => {
  const reportedAtmRef = useRef(false)
  const reportedOceanRef = useRef(false)
  useEffect(() => {
    if (refs == null) return
    let cancelled = false
    let stableFrames = 0
    const phaseStart = performance.now()
    const fire = (cb: (ms: number) => void): void => {
      // One extra rAF after the stability window so the first render-after-
      // ready has completed (shader/material compile during first draw).
      requestAnimationFrame(() => {
        if (cancelled) return
        cb(performance.now() - phaseStart)
      })
    }
    const tick = (): void => {
      if (cancelled) return
      if (phase === 'atmosphere' && !reportedAtmRef.current) {
        const lut = (refs.atmosphereContext as any)?.lutNode
        const atmosphereReady =
          lut != null && lut.currentVersion != null && lut.updating === false
        stableFrames = atmosphereReady ? stableFrames + 1 : 0
        if (stableFrames >= STABLE_FRAMES) {
          reportedAtmRef.current = true
          fire(onAtmosphereReady)
          return
        }
      } else if (phase === 'ocean' && !reportedOceanRef.current) {
        const mgr = refs.getOceanManager()
        const chunkCount =
          mgr?.chunks_ != null ? Object.keys(mgr.chunks_).length : 0
        const oceanReady =
          mgr != null &&
          mgr.builder_ != null &&
          mgr.builder_.Busy === false &&
          chunkCount > 0
        stableFrames = oceanReady ? stableFrames + 1 : 0
        if (stableFrames >= STABLE_FRAMES) {
          reportedOceanRef.current = true
          fire(onOceanReady)
          return
        }
      } else {
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      cancelled = true
    }
  }, [refs, phase, onAtmosphereReady, onOceanReady])
  return null
}

// Forces the renderer to the true window size after first layout and on every
// resize / fullscreen transition. R3F's own ResizeObserver can latch a stale
// size when the canvas mounts small and the window goes fullscreen late (the
// Electron wrapper) — leaving the backbuffer + depth attachment at the 300x150
// canvas default while the color attachment is retina-fullscreen, which trips
// the WebGPU "depthBuffer size does not match color attachment" validation and
// blacks out the scene. The canvas is position:fixed inset:0, so window.inner*
// IS the canvas size; re-applying setSize/setDpr on the events that matter
// (rAF after mount, window 'resize' — Electron OS-fullscreen fires this, not
// document 'fullscreenchange' — and 'fullscreenchange' for the browser path)
// repairs the whole size pipeline: backbuffer (gl.setSize), the pass node
// (renderer.getSize), and size-keyed depth targets (useThree().size).
const ResizeSync: FC = () => {
  const setSize = useThree(state => state.setSize)
  const setDpr = useThree(state => state.setDpr)
  useEffect(() => {
    const apply = (): void => {
      // Match R3F's own default clamp ([1, 2]) — never uncap DPR, or DPR-3
      // displays would render at 2.25x the pixels (perf regression).
      setDpr([1, 2])
      setSize(window.innerWidth, window.innerHeight)
      // TEMP diagnostic — remove once the Electron fullscreen resize is verified.
      // eslint-disable-next-line no-console
      console.log(
        `[resize-sync] ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`
      )
    }
    const raf = requestAnimationFrame(apply)
    window.addEventListener('resize', apply)
    document.addEventListener('fullscreenchange', apply)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', apply)
      document.removeEventListener('fullscreenchange', apply)
    }
  }, [setSize, setDpr])
  return null
}

const App: FC = () => {
  const [refs, setRefs] = useState<ContentReadinessRefs | null>(null)
  const [phase, setPhase] = useState<Phase>('atmosphere')
  // Active scene location, surfaced from Content's leva 'Location' control so
  // the conditions HUD fetches MET data for the point currently in view.
  // Defaults to Karmøy (the offshore-wind site) until Content reports.
  const [location, setLocation] = useState({
    longitude: 5.206866,
    latitude: 59.427348,
    name: 'Karmøy'
  })

  const handleReadinessRefs = useCallback(
    (r: ContentReadinessRefs) => setRefs(r),
    []
  )

  const handleLocationChange = useCallback(
    (longitude: number, latitude: number, name: string) =>
      setLocation({ longitude, latitude, name }),
    []
  )

  // Farm size, surfaced from Content's leva Turbine control, so the inspector
  // can show the farm total (count × per-turbine output).
  // Per-site turbine count (drives the farm AND the inspector total). Defaults
  // to Karmøy's; updated on POI fly-to. App-owned, so it's the single source.
  const [turbineCount, setTurbineCount] = useState(15)

  // Camera controls (ControlsPanel). flyTo drives the CameraRig fly animation.
  const [autoRotate, setAutoRotate] = useState(true)
  // `zoom` is the COMMANDED orbit distance (drives the CameraRig ease).
  // `liveZoom` is the camera's ACTUAL distance, reported back each frame, so the
  // slider thumb tracks mouse-wheel zoom too. Dragging the slider commands both
  // (snap the thumb, then the camera eases toward it).
  const [zoom, setZoom] = useState(600)
  const [liveZoom, setLiveZoom] = useState(600)
  const commandZoom = useCallback((v: number) => {
    setZoom(v)
    setLiveZoom(v)
  }, [])
  const [wingsOn, setWingsOn] = useState(true)
  // Hero-turbine cover toggle (only the hero GLB carries this node).
  const [coverOn, setCoverOn] = useState(true)
  // Fly command for the CameraRig. POIs carry just name+lon/lat; scenario
  // viewpoints add aim height / camera-only ENU aim offset + heading/pitch
  // (full camera presets).
  const [flyTo, setFlyTo] = useState<{
    name: string
    longitude: number
    latitude: number
    height?: number
    aimOffsetENU?: [number, number, number]
    // Target orbit distance for this fly — owned by the fly animation, not the
    // zoom slider, so it can't race the slider-ease into a pre-fly snap.
    distance?: number
    headingDeg?: number
    pitchDeg?: number
    // Turbine facing (deg) the heading was framed at — set on nacelle/rotor
    // close-ups so Content circles the camera with the live-yawed model.
    headingRefYaw?: number
    // Gentle recenter: ease the orbit centre over at the CURRENT distance with
    // no great-circle pull-out arc (for clicking a globe marker, where you're
    // already pulled back and just want the centre to slew to it).
    gentle?: boolean
    // Monotonic fly id (see flyNonceRef): the rig re-flies whenever this changes,
    // so a click always re-frames even when target/aim are unchanged.
    nonce?: number
  } | null>(null)

  // Scenario selection (ScenarioPanel, bottom-right). The scene loads at
  // Karmøy with the farm up, so that scenario starts active.
  const [activeScenario, setActiveScenario] = useState<string | null>('karmoy')
  const [activeViewpoint, setActiveViewpoint] = useState<string | null>(
    'overview'
  )

  // Camera mode (orbit / first-person) + the FPS spawn pose. The nonce forces
  // a respawn even when re-entering FPS at the same scenario.
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit')
  const [fpsSpawn, setFpsSpawn] = useState<
    | (NonNullable<ReturnType<typeof spawnFor>> & { nonce: number })
    | null
  >(null)
  const spawnNonceRef = useRef(0)
  // Monotonic fly id. A viewpoint CLICK is the fly trigger, not an incidental
  // change in target/aim: two close-ups can share an aim (Hregg / Hregg Close)
  // and differ only in distance/heading, and re-selecting a viewpoint after the
  // wind (hence the yaw-relative heading) changed must re-frame. Bumping this on
  // every fly command makes the rig re-fly on intent rather than coordinate diff.
  const flyNonceRef = useRef(0)

  const respawnAt = useCallback((scenario: Scenario, viewpoint: Viewpoint) => {
    const spawn = spawnFor(scenario, viewpoint)
    if (spawn == null) return
    setFpsSpawn({ ...spawn, nonce: ++spawnNonceRef.current })
  }, [])

  const handleCameraMode = useCallback(
    (mode: CameraMode) => {
      setCameraMode(mode)
      if (mode === 'fps') {
        const scenario =
          SCENARIOS.find(s => s.id === activeScenario) ?? SCENARIOS[0]
        const viewpoint =
          scenario.viewpoints.find(v => v.id === activeViewpoint) ??
          scenario.viewpoints[0]
        respawnAt(scenario, viewpoint)
      }
    },
    [activeScenario, activeViewpoint, respawnAt]
  )

  // Flying to a scenario viewpoint: full camera preset (aim height or
  // camera-only ENU offset, landing distance via the zoom command,
  // heading/pitch) + the scenario's farm size. Preset-anchored scenarios
  // (Karmøy) keep the location pinned to the preset across viewpoints, so the
  // farm and baked cables never re-centre; only the camera aim moves.
  // In FPS mode the orbit fly is moot (the rig is unmounted) — the location
  // still moves, and the player respawns at the scenario's spawn point.
  const handleScenarioSelect = useCallback(
    (scenario: Scenario, viewpoint: Viewpoint) => {
      const anchor =
        scenario.preset != null
          ? locationPresets[scenario.preset as keyof typeof locationPresets]
          : null
      const longitude = viewpoint.longitude ?? anchor?.longitude
      const latitude = viewpoint.latitude ?? anchor?.latitude
      if (longitude == null || latitude == null) {
        throw new Error(
          `Scenario '${scenario.id}' viewpoint '${viewpoint.id}' has neither coordinates nor a preset anchor`
        )
      }
      setFlyTo({
        // The preset name keeps Content on the preset location (stable target).
        name: scenario.preset ?? scenario.label,
        longitude,
        latitude,
        height: viewpoint.height,
        aimOffsetENU: viewpoint.aimOffsetENU,
        // Distance rides on the fly itself (the rig animates to it) — NOT the
        // zoom slider, so there's no pre-fly snap.
        distance: viewpoint.distance,
        headingDeg: viewpoint.headingDeg,
        pitchDeg: viewpoint.pitchDeg,
        headingRefYaw: viewpoint.headingRefYaw,
        nonce: ++flyNonceRef.current
      })
      setTurbineCount(scenario.turbines ?? 0)
      setActiveScenario(scenario.id)
      setActiveViewpoint(viewpoint.id)
      if (cameraMode === 'fps') {
        respawnAt(scenario, viewpoint)
      }
    },
    [cameraMode, respawnAt]
  )

  // Single source of truth for forecast-driven state, shared by the DOM cards
  // and the 3D turbine. Lives here (not in DigitalTwinUI) so the modelled rotor
  // RPM can feed Content -> TurbineProbe at the same selected time as the HUD.
  const { loading, error, rangeStart, rangeEnd, sampleAt } = useMetForecast(
    location.latitude,
    location.longitude
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60 * 1000)
    return () => clearInterval(id)
  }, [])
  // null = follow 'now'; a number = user has scrubbed to a fixed instant.
  const [scrubbed, setScrubbed] = useState<number | null>(null)
  const clampedNow = useMemo(() => {
    if (rangeStart == null || rangeEnd == null) return nowMs
    return Math.min(Math.max(nowMs, rangeStart), rangeEnd)
  }, [nowMs, rangeStart, rangeEnd])
  const selected = scrubbed ?? clampedNow
  const sample = useMemo(
    () => sampleAt(new Date(selected)),
    [sampleAt, selected]
  )
  const telemetry = useMemo(
    () =>
      modelTurbine(
        sample?.windSpeed ?? null,
        sample?.windFromDirection ?? null
      ),
    [sample]
  )

  // Live AIS positions (BarentsWatch, via the same-origin proxy): the sanctioned
  // shadow fleet (red) and Coast Guard / Navy patrol vessels (blue). Empty until
  // server-side credentials are configured — never fabricated. Fed to Content's
  // globe-overview marker layers, shown only when pulled back to a globe view.
  const {
    shadowFleet,
    patrol,
    updatedAt: aisUpdatedAt,
    error: aisError
  } = useShadowFleetAis(true)
  const shadowFleetVessels = useMemo(
    () => shadowFleet.map(toMarker),
    [shadowFleet]
  )
  const patrolVessels = useMemo(() => patrol.map(toMarker), [patrol])

  // Clicked globe marker → full callout, keyed by the vessel's stable id (IMO or
  // mmsi-derived). Resolves the live record from whichever layer holds it and
  // tags its category; shadow-fleet vessels also merge the EU sanctions
  // metadata. Null if the vessel left the feed — the callout closes, no stale
  // data.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedVessel = useMemo<SelectedVessel | null>(() => {
    if (selectedId == null) return null
    const shadow = shadowFleet.find(v => v.id === selectedId)
    if (shadow != null) {
      const meta =
        shadow.imo != null ? SHADOW_FLEET_BY_IMO.get(shadow.imo) : undefined
      return {
        ...shadow,
        category: 'shadow',
        formerly: meta?.formerly ?? null,
        groundLabel:
          meta?.ground != null
            ? (SHADOW_FLEET_GROUND_LABEL[meta.ground] ?? null)
            : null,
        listed: meta?.listed ?? null
      }
    }
    const patrolVessel = patrol.find(v => v.id === selectedId)
    if (patrolVessel != null) {
      return {
        ...patrolVessel,
        category: 'patrol',
        formerly: null,
        groundLabel: null,
        listed: null
      }
    }
    return null
  }, [selectedId, shadowFleet, patrol])

  // Selected vessel's last-24h historic track, auto-fetched on every selection
  // (keyed by MMSI). Null mmsi → no fetch. Drawn by Content's overlay.
  const { points: trackPoints } = useVesselTrack(selectedVessel?.mmsi ?? null)

  // Selected vessel's live nav for the forward-projection overlay (where she'll
  // be after 30 min / 1 h / 3 h along her course).
  const selectedVesselNav = useMemo<SelectedVesselNav | null>(
    () =>
      selectedVessel == null
        ? null
        : {
            latitude: selectedVessel.latitude,
            longitude: selectedVessel.longitude,
            courseOverGround: selectedVessel.courseOverGround,
            speedOverGround: selectedVessel.speedOverGround
          },
    [selectedVessel]
  )

  // Click any vessel marker → open the callout AND fly the orbit camera to
  // centre on it (holding the current distance; the marker stays visible). A
  // standalone "inspect tracked vessel" action, distinct from a scenario: clears
  // scenario state and the farm so the rig frames the vessel, not a site.
  const handleVesselSelect = useCallback(
    (id: string) => {
      setSelectedId(id)
      const p =
        shadowFleet.find(v => v.id === id) ?? patrol.find(v => v.id === id)
      if (p == null) return
      setActiveScenario(null)
      setActiveViewpoint(null)
      setTurbineCount(0)
      // Descend straight onto the vessel: top-down, north-up (like the
      // BarentsWatch viewpoint), zoomed in. `gentle` keeps it a direct descent
      // with no great-circle pull-out arc; the rig still honors `distance`.
      setFlyTo({
        name: p.name ?? p.imo ?? id,
        longitude: p.longitude,
        latitude: p.latitude,
        height: 0,
        distance: VESSEL_FOCUS_DISTANCE,
        headingDeg: VESSEL_FOCUS_HEADING,
        pitchDeg: VESSEL_FOCUS_PITCH,
        gentle: true,
        nonce: ++flyNonceRef.current
      })
    },
    [shadowFleet, patrol]
  )

  // Marker-layer visibility, toggled from the high-altitude AIS panel. Hiding a
  // layer that owns the selected vessel also closes its callout (no orphaned
  // card with no marker).
  const [layerVisible, setLayerVisible] = useState({
    shadow: true,
    patrol: true
  })
  const handleLayerToggle = useCallback(
    (layer: 'shadow' | 'patrol') => {
      const willHide = layerVisible[layer]
      setLayerVisible(v => ({ ...v, [layer]: !v[layer] }))
      if (willHide && selectedId != null) {
        const list = layer === 'shadow' ? shadowFleet : patrol
        if (list.some(v => v.id === selectedId)) setSelectedId(null)
      }
    },
    [layerVisible, selectedId, shadowFleet, patrol]
  )

  // Selected-vessel overlay visibility (historic track + course projection),
  // toggled from the same AIS panel.
  const [overlayVisible, setOverlayVisible] = useState({
    track: true,
    projection: true
  })
  const handleOverlayToggle = useCallback((overlay: 'track' | 'projection') => {
    setOverlayVisible(v => ({ ...v, [overlay]: !v[overlay] }))
  }, [])

  // Subsea cable layers (OSM/ODbL), toggled from the same AIS panel. Default
  // OFF — opt-in from the panel (keeps the overview uncluttered by default).
  const [cableVisible, setCableVisible] = useState({
    power: false,
    telecom: false
  })
  const handleCableToggle = useCallback((layer: 'power' | 'telecom') => {
    setCableVisible(v => ({ ...v, [layer]: !v[layer] }))
  }, [])

  // Installation-rig playback (turbine-install scenario): the active clip drives
  // the rig's AnimationMixer; speed is its timeScale. The sequence chains the 10
  // install phases (advance on each clip's 'finished' event) then settles to the
  // operating idle loop. Default = idle, so arriving frames a finished rig.
  const [rigClip, setRigClip] = useState<string>(IDLE_CLIP)
  const [rigSpeed, setRigSpeed] = useState(1)
  const [playingSequence, setPlayingSequence] = useState(false)
  // Latest sequence flag for the (stable) clip-finished handler.
  const playingSeqRef = useRef(false)
  useEffect(() => {
    playingSeqRef.current = playingSequence
  }, [playingSequence])

  const handleSelectPhase = useCallback((clip: string) => {
    setPlayingSequence(false)
    setRigClip(clip)
  }, [])
  const handlePlaySequence = useCallback(() => {
    setPlayingSequence(true)
    setRigClip(INSTALL_CLIPS[0])
  }, [])
  // Advance the sequence when a one-shot phase finishes; settle into the
  // looping Operating state after the last phase. Reads the live flag via ref
  // so the callback stays stable.
  const handleRigClipFinished = useCallback((finished: string) => {
    if (!playingSeqRef.current) return
    const i = (INSTALL_CLIPS as readonly string[]).indexOf(finished)
    if (i < 0) return
    const next = INSTALL_CLIPS[i + 1]
    if (next != null) {
      setRigClip(next)
    } else {
      setPlayingSequence(false)
      setRigClip(IDLE_CLIP)
    }
  }, [])

  // Show the AIS-layers panel (instead of point weather) once pulled back to the
  // globe overview. The scene owns this LOD (it knows the true camera altitude)
  // and reports it via Content's onOverviewChange — the SAME boolean that drives
  // the markers, so the panel and the markers always swap together.
  const [aisOverview, setAisOverview] = useState(false)

  const handleAtmosphereReady = useCallback((elapsedMs: number) => {
    // eslint-disable-next-line no-console
    console.log(`[ready] atmosphere LUTs computed in ${elapsedMs.toFixed(0)}ms`)
    setPhase('ocean')
  }, [])

  const handleOceanReady = useCallback((elapsedMs: number) => {
    // eslint-disable-next-line no-console
    console.log(`[ready] ocean chunks built in ${elapsedMs.toFixed(0)}ms`)
    setPhase('ready')
  }, [])

  return (
    <>
      <Canvas
        camera={{ fov: 45, near: 0.1, far: 1e8 }}
        style={{ position: 'fixed', inset: 0, background: '#101820' }}
        // Apply resize immediately (no debounce) so the renderer tracks late
        // fullscreen transitions without a stale-size window; ResizeSync below
        // is the belt to this suspenders.
        resize={{ debounce: 0 }}
        gl={async props => {
          const renderer = new WebGPURenderer({
            ...(props as any),
            antialias: true,
            logarithmicDepthBuffer: true
          })
          await renderer.init()
          renderer.highPrecision = true
          renderer.outputColorSpace = SRGBColorSpace
          renderer.toneMapping = NoToneMapping
          renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)
          return renderer as unknown as Renderer
        }}
      >
        <Content
          onReadinessRefs={handleReadinessRefs}
          disableOcean={phase === 'atmosphere'}
          onLocationChange={handleLocationChange}
          turbineRpm={telemetry.rpm}
          windHeading={telemetry.yawHeading}
          windSpeed={sample?.windSpeed ?? null}
          clockMs={selected}
          precip={sample?.precipitation ?? null}
          airTemperature={sample?.airTemperature ?? null}
          flyTo={flyTo}
          cameraMode={cameraMode}
          fpsSpawn={fpsSpawn}
          shadowFleetVessels={layerVisible.shadow ? shadowFleetVessels : NO_VESSELS}
          patrolVessels={layerVisible.patrol ? patrolVessels : NO_VESSELS}
          onVesselSelect={handleVesselSelect}
          selectedVesselId={selectedId}
          selectedVesselNav={selectedVesselNav}
          trackPoints={trackPoints}
          showProjection={overlayVisible.projection}
          showTrack={overlayVisible.track}
          showPowerCables={cableVisible.power}
          showTelecomCables={cableVisible.telecom}
          farmCount={turbineCount}
          rigClip={rigClip}
          rigTimeScale={rigSpeed}
          onRigClipFinished={handleRigClipFinished}
          autoRotate={autoRotate}
          zoomDistance={zoom}
          onZoomChange={setLiveZoom}
          onOverviewChange={setAisOverview}
          wingsEnabled={wingsOn}
          heroCover={coverOn}
        />
        <ReadinessProbe
          refs={refs}
          phase={phase}
          onAtmosphereReady={handleAtmosphereReady}
          onOceanReady={handleOceanReady}
        />
        <ResizeSync />
      </Canvas>
      <BrandMark />
      <DigitalTwinUI
        locationName={location.name}
        loading={loading}
        error={error}
        sample={sample}
        telemetry={telemetry}
        turbineCount={turbineCount}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        now={clampedNow}
        selected={selected}
        onScrub={setScrubbed}
        ais={SCENARIOS.find(s => s.id === activeScenario)?.ais ?? null}
        bunkering={
          SCENARIOS.find(s => s.id === activeScenario)?.bunkering ?? null
        }
        selectedVessel={selectedVessel}
        onCloseVessel={() => setSelectedId(null)}
        installControls={
          activeScenario === 'turbine-install'
            ? ({
                activeClip: rigClip,
                speed: rigSpeed,
                playingSequence,
                onSelectPhase: handleSelectPhase,
                onSetSpeed: setRigSpeed,
                onPlaySequence: handlePlaySequence
              } satisfies InstallControlsState)
            : null
        }
        aisLayers={{
          overview: aisOverview,
          shadowVisible: layerVisible.shadow,
          patrolVisible: layerVisible.patrol,
          shadowCount: shadowFleet.length,
          patrolCount: patrol.length,
          onToggle: handleLayerToggle,
          trackVisible: overlayVisible.track,
          projectionVisible: overlayVisible.projection,
          onToggleOverlay: handleOverlayToggle,
          cablePowerVisible: cableVisible.power,
          cableTelecomVisible: cableVisible.telecom,
          onToggleCable: handleCableToggle,
          updatedAt: aisUpdatedAt,
          error: aisError
        }}
        cameraControls={
          {
            mode: cameraMode,
            onMode: handleCameraMode,
            autoRotate,
            onAutoRotate: setAutoRotate,
            zoom: liveZoom,
            zoomMin: ZOOM_MIN,
            zoomMax: ZOOM_MAX,
            onZoom: commandZoom
          } satisfies CameraControlsState
        }
        scenarioControls={
          {
            scenarios: SCENARIOS,
            activeScenario,
            activeViewpoint,
            onSelect: handleScenarioSelect,
            // Registry the scenarios' `settings` ids resolve against — the
            // wind-farm toggles live here now (moved from the camera panel).
            settings: {
              rotorSpin: {
                label: 'Rotor spin',
                on: wingsOn,
                onChange: setWingsOn
              },
              cover: { label: 'Cover', on: coverOn, onChange: setCoverOn }
            }
          } satisfies ScenarioControlsState
        }
      />
      {/* Debug controls: kept, but collapsed by default and out of the way
          (top-right; the conditions HUD stacks below it). */}
      <Leva collapsed />
      <Splash visible={phase !== 'ready'} phase={phase} />
    </>
  )
}

// Top-left Huma brand mark — a faithful port of the humatopia-frontend sidebar
// menu button (logo box + HumaDisplay "humatopia" wordmark). Plain DOM sibling
// of the canvas; Tailwind/shadcn classes there are reproduced here as inline
// styles since this demo has no Tailwind. Wordmark uses the dark-theme
// --sidebar-foreground (warm near-white) so it reads on the dark globe scene.
// Sits below the Splash (z 5 < 10) so it reveals with the scene, not the cover.
const BrandMark: FC = () => (
  <div style={{ position: 'fixed', top: 8, left: 8, zIndex: 5 }}>
    <a
      href="/"
      className="huma-brand"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem', // gap-2
        height: '3rem', // h-12
        padding: '0.5rem', // p-2
        borderRadius: 0, // --radius: 0 (sharp corners)
        textAlign: 'left',
        textDecoration: 'none',
        outline: 'none',
        color: '#13294b',
        transition: 'background-color 150ms cubic-bezier(0.4, 0, 0.2, 1)'
      }}
    >
      <div
        style={{
          display: 'flex',
          aspectRatio: '1 / 1',
          width: '2rem', // size-8
          height: '2rem',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <img
          src="/public/brand/huma-favicon.png"
          alt="Huma"
          style={{ width: '1.25rem', height: '1.25rem' }} // size-5
        />
      </div>
      <div style={{ display: 'grid', flex: 1, textAlign: 'left', lineHeight: 1.25 }}>
        <span
          style={{
            fontFamily: "'HumaDisplay', sans-serif",
            fontWeight: 300,
            textTransform: 'lowercase',
            fontSize: '1.3rem',
            letterSpacing: '0.01em'
          }}
        >
          Humatopia
        </span>
        <span
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
            fontSize: '0.55rem',
            fontWeight: 500,
            letterSpacing: '0.18em',
            textTransform: 'uppercase'
          }}
        >
          Digital Twin World
        </span>
      </div>
    </a>
    <style>{`.huma-brand:hover { background-color: oklch(0.2686 0 0); }`}</style>
  </div>
)

// Minimal cover: full-bleed dark backdrop matching the canvas clear color, a
// small spinner, and one muted monospace status line that mirrors the console
// milestones (what the loader is doing this phase). Fades out (500 ms) once the
// loader reports ready. No spinning while ready — display:none after the fade
// so the spinner doesn't burn cycles in the background.
const PHASE_STATUS: Record<Phase, string> = {
  atmosphere: 'Precomputing atmosphere…',
  ocean: 'Building ocean…',
  ready: 'Ready'
}

const Splash: FC<{ visible: boolean; phase: Phase }> = ({ visible, phase }) => {
  const [mounted, setMounted] = useState(true)
  useEffect(() => {
    if (visible) return
    const t = setTimeout(() => setMounted(false), 500)
    return () => clearTimeout(t)
  }, [visible])
  if (!mounted) return null
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#101820',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        opacity: visible ? 1 : 0,
        transition: 'opacity 500ms ease-out',
        pointerEvents: visible ? 'auto' : 'none',
        zIndex: 10
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          border: '2px solid rgba(207, 216, 227, 0.2)',
          borderTopColor: 'rgba(207, 216, 227, 0.9)',
          animation: 'gwp-spin 0.9s linear infinite'
        }}
      />
      <div
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
          fontSize: 11,
          letterSpacing: '0.08em',
          color: 'rgba(207, 216, 227, 0.55)'
        }}
      >
        {PHASE_STATUS[phase]}
      </div>
      <style>{`@keyframes gwp-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

void detectWebGPU().then(available => {
  if (!available) {
    unsupportedElement?.classList.add('show')
    return
  }
  // Surface any worker-side throws routed back via the synthetic-message
  // path injected by ifftWorkerHardeningPlugin (see vite.config.ts).
  window.addEventListener('message', e => {
    if (e?.data?.__workerError) {
      // eslint-disable-next-line no-console
      console.error('[ocean-worker:error]', e.data)
    }
  })
  // No StrictMode — the chunk-rebuilder pool and atmosphere LUT pipeline
  // both hold mutable WebGPU state that doesn't survive the mount/unmount/
  // remount cycle StrictMode performs in development.
  createRoot(rootElement).render(<App />)
})
