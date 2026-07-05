// The twin experience shared by both shells: owns all visitor runtime state
// (camera, scenario/viewpoint, AIS, MET forecast, install rig, slideshows) and
// composes SceneHost + Content + the DOM overlay (BrandMark, DigitalTwinUI,
// Leva). Visitor mode renders it bare; author mode injects authoring chrome
// through the authorSlot render prop — author code never imports back in here.

import { Leva } from 'leva'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode
} from 'react'

import {
  Content,
  locationPresets,
  type ContentReadinessRefs,
  type SelectedVesselNav,
  type VesselMarker
} from '../../../storybook-webgpu/src/ocean/GlobeWaterproOcean-Story'
import type { CameraPose } from '../sites/enu'
import type { SiteDefinition } from '../sites/types'
import {
  DigitalTwinUI,
  type CameraControlsState,
  type CameraMode,
  type InstallControlsState,
  type ScenarioControlsState,
  type SelectedVessel
} from '../ui/DigitalTwinUI'
import { IDLE_CLIP, INSTALL_CLIPS } from '../ui/rigPhases'
import { SCENARIOS, type Scenario, type Viewpoint } from '../ui/scenarios'
import { SHADOW_FLEET, SHADOW_FLEET_GROUND_LABEL } from '../ui/shadowFleet'
import type { SlideshowControlsState } from '../ui/SlideshowViewer'
import { modelTurbine } from '../ui/turbineModel'
import { composeScenarioCatalogue } from '../sites/runtime'
import { useAuthoredSites } from '../ui/useAuthoredScenarios'
import { useMetForecast } from '../ui/useMetForecast'
import { useScenarioSlideshows } from '../ui/useScenarioSlideshows'
import {
  useShadowFleetAis,
  type ShadowFleetPosition
} from '../ui/useShadowFleetAis'
import { useVesselTrack } from '../ui/useVesselTrack'
import type { CameraCommand, FlyToTarget } from './cameraCommands'
import { SceneHost } from './SceneHost'

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
  const longitude = spawn?.longitude ?? viewpoint.longitude ?? anchor?.longitude
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

// What the author shell can reach inside the running experience: the active
// scenario, the (include-disabled) deck list + its refetch + deck preview,
// and the camera dispatch. Deliberately narrow — authoring reads/commands
// through this context instead of owning copies of runtime state.
export interface AuthorSlotContext {
  // The ONE selection, shared with the scene's scenario panel: the sidebar's
  // scenario/view navigation drives the same state the visitor UI reads, so
  // both surfaces always mirror each other.
  activeScenarioId: string | null
  activeViewpointId: string | null
  scenarios: {
    // The merged runtime catalogue in panel order (static + authored).
    list: Scenario[]
    // Select a scenario (flies to its default view; an authored scenario
    // with no views yet is selected without a fly).
    select: (scenarioId: string) => void
    // Select a specific view of a scenario (flies to it).
    selectView: (scenarioId: string, viewpointId: string) => void
  }
  // The ONE fetched copy of the authored site manifest, shared by the runtime
  // catalogue and the author tooling — mutations refetch it exactly once.
  sites: {
    authored: SiteDefinition[]
    updatedAt: string | null
    refresh: () => Promise<void>
  }
  slideshows: {
    decks: ReturnType<typeof useScenarioSlideshows>['decks']
    refresh: () => Promise<void>
    // Open a deck in the visitor slideshow modal (author preview).
    openDeck: (deckId: string) => void
  }
  // Live orbit-camera pose for viewpoint capture; null in FPS mode or before
  // the scene has mounted its controls.
  getCameraPose: () => CameraPose | null
  dispatchCamera: (command: CameraCommand) => void
}

// Width of the docked author sidebar. The scene pane takes the rest.
const AUTHOR_DOCK_WIDTH = 320

export interface TwinExperienceProps {
  // Author mode: fetch draft slideshows/scenarios too (honored server-side
  // only for an authenticated admin session).
  isAuthorMode?: boolean
  // Author mode: content for the docked sidebar. When present, the layout
  // becomes a split workspace — an opaque sidebar the slot fills, and the
  // scene pane holding the canvas plus the ENTIRE visitor overlay. The pane
  // is transformed (translateZ(0)), which makes it the containing block for
  // every position:fixed element inside (HUD cards, splash, slideshow modal,
  // Leva), so the visitor UI anchors to the pane instead of the viewport and
  // can never stack under the sidebar. Visitor mode renders with no wrapper.
  authorSlot?: (ctx: AuthorSlotContext) => ReactNode
}

export const TwinExperience: FC<TwinExperienceProps> = ({
  isAuthorMode = false,
  authorSlot
}) => {
  // Active scene location, surfaced from Content's leva 'Location' control so
  // the conditions HUD fetches MET data for the point currently in view.
  // Defaults to Karmøy (the offshore-wind site) until Content reports.
  const [location, setLocation] = useState({
    longitude: 5.206866,
    latitude: 59.427348,
    name: 'Karmøy'
  })

  const handleLocationChange = useCallback(
    (longitude: number, latitude: number, name: string) =>
      setLocation({ longitude, latitude, name }),
    []
  )

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
  const [flyTo, setFlyTo] = useState<FlyToTarget | null>(null)

  // Scenario selection (ScenarioPanel, bottom-right). The scene loads at
  // Karmøy with the farm up, so that scenario starts active.
  const [activeScenario, setActiveScenario] = useState<string | null>('karmoy')
  const [activeViewpoint, setActiveViewpoint] = useState<string | null>(
    'overview'
  )
  const [activeSlideshowId, setActiveSlideshowId] = useState<string | null>(
    null
  )
  const [slideshowOpen, setSlideshowOpen] = useState(false)
  const slideshows = useScenarioSlideshows(activeScenario, isAuthorMode)

  // Runtime scenario catalogue: static (code-owned) entries — extended with
  // authored views where a site's anchor allows — plus author-created
  // scenarios from the site manifest. Static wins on id collision; authored
  // data adds, never replaces (inspector payloads, FPS spawns, settings).
  const authored = useAuthoredSites(isAuthorMode)
  // Full catalogue, including drafts — author mode manages every scenario
  // from this (authorContext.scenarios.list below). Visitors only ever see
  // visibleScenarios (the scenario picker in scenarioControls further down).
  const scenarios = useMemo(
    () => composeScenarioCatalogue(SCENARIOS, authored.sites),
    [authored.sites]
  )
  const visibleScenarios = useMemo(
    () => scenarios.filter(s => s.enabled !== false),
    [scenarios]
  )

  // The active scenario definition, resolved once per change instead of a
  // fresh linear catalogue find in each consuming prop on every render.
  const activeScenarioDef = useMemo(
    () => scenarios.find(s => s.id === activeScenario) ?? null,
    [scenarios, activeScenario]
  )

  useEffect(() => {
    setActiveSlideshowId(null)
    setSlideshowOpen(false)
  }, [activeScenario])

  useEffect(() => {
    if (
      activeSlideshowId != null &&
      !slideshows.decks.some(deck => deck.id === activeSlideshowId)
    ) {
      setActiveSlideshowId(null)
      setSlideshowOpen(false)
    }
  }, [activeSlideshowId, slideshows.decks])

  // Camera mode (orbit / first-person) + the FPS spawn pose. The nonce forces
  // a respawn even when re-entering FPS at the same scenario.
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit')
  const [fpsSpawn, setFpsSpawn] = useState<
    (NonNullable<ReturnType<typeof spawnFor>> & { nonce: number }) | null
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

  // Respawn the FPS player at the active scenario/viewpoint (shared by the
  // mode switch and the author-side 'respawn' command).
  const respawnActive = useCallback(() => {
    const scenario =
      scenarios.find(s => s.id === activeScenario) ?? scenarios[0]
    const viewpoint =
      scenario.viewpoints.find(v => v.id === activeViewpoint) ??
      scenario.viewpoints[0]
    respawnAt(scenario, viewpoint)
  }, [scenarios, activeScenario, activeViewpoint, respawnAt])

  const handleCameraMode = useCallback(
    (mode: CameraMode) => {
      setCameraMode(mode)
      if (mode === 'fps') {
        respawnActive()
      }
    },
    [respawnActive]
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
      setActiveSlideshowId(null)
      setSlideshowOpen(false)
      if (cameraMode === 'fps') {
        respawnAt(scenario, viewpoint)
      }
    },
    [cameraMode, respawnAt]
  )

  // Author-side camera dispatch (see cameraCommands.ts): the one channel
  // through which authoring tooling drives the camera. Owns the fly nonce so
  // producers only state intent; bypasses Leva entirely.
  const dispatchCamera = useCallback(
    (command: CameraCommand) => {
      switch (command.type) {
        case 'fly-to':
          setFlyTo({ ...command.target, nonce: ++flyNonceRef.current })
          break
        case 'set-mode':
          handleCameraMode(command.mode)
          break
        case 'respawn':
          respawnActive()
          break
      }
    },
    [handleCameraMode, respawnActive]
  )

  // Readiness refs mirrored from SceneHost, for the author-mode viewpoint
  // capture (getCameraPose). A ref, not state — read on demand at capture.
  const readinessRefsRef = useRef<ContentReadinessRefs | null>(null)
  const handleReadinessRefs = useCallback((refs: ContentReadinessRefs) => {
    readinessRefsRef.current = refs
  }, [])

  // Sidebar navigation → the same selection path the scenario panel uses.
  // An authored scenario with no views yet can't fly (the rig needs a
  // viewpoint) but must still become the active editing context.
  const selectScenario = useCallback(
    (scenarioId: string) => {
      const scenario = scenarios.find(s => s.id === scenarioId)
      if (scenario != null && scenario.viewpoints.length > 0) {
        handleScenarioSelect(scenario, scenario.viewpoints[0])
        return
      }
      setActiveScenario(scenarioId)
      setActiveViewpoint(null)
      setActiveSlideshowId(null)
      setSlideshowOpen(false)
    },
    [scenarios, handleScenarioSelect]
  )

  const selectViewpoint = useCallback(
    (scenarioId: string, viewpointId: string) => {
      const scenario = scenarios.find(s => s.id === scenarioId)
      const viewpoint = scenario?.viewpoints.find(v => v.id === viewpointId)
      if (scenario != null && viewpoint != null) {
        handleScenarioSelect(scenario, viewpoint)
      }
    },
    [scenarios, handleScenarioSelect]
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

  // A scenario can pin time-of-day and/or force calm weather — e.g. an
  // indoor site where neither the sun nor local MET apply. Content owns the
  // actual blend (see the pin-mix ref there): while a pin is active/inactive
  // and settled, the scrubber/live clock drives the scene with zero lag;
  // only the moment a scenario engages or releases a pin eases smoothly.
  // Weather has no such blend, so it's forced to concrete calm values here
  // rather than `null` — `null` doesn't mean "off", it means "let the
  // manual Leva panel decide", which is whatever it was last left at.
  const environment = activeScenarioDef?.environment

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

  // Author slot context, memoized: liveZoom re-renders this component every
  // frame while the camera moves, and a stable ctx (with memo'd AuthorSidebar)
  // keeps that churn out of the author chrome.
  const openDeck = useCallback((deckId: string) => {
    setActiveSlideshowId(deckId)
    setSlideshowOpen(true)
  }, [])
  const getCameraPose = useCallback(
    () => readinessRefsRef.current?.getCameraPose?.() ?? null,
    []
  )
  const authorContext = useMemo<AuthorSlotContext>(
    () => ({
      activeScenarioId: activeScenario,
      activeViewpointId: activeViewpoint,
      scenarios: {
        list: scenarios,
        select: selectScenario,
        selectView: selectViewpoint
      },
      sites: {
        authored: authored.sites,
        updatedAt: authored.updatedAt,
        refresh: authored.refresh
      },
      slideshows: {
        decks: slideshows.decks,
        refresh: slideshows.refresh,
        openDeck
      },
      getCameraPose,
      dispatchCamera
    }),
    [
      activeScenario,
      activeViewpoint,
      scenarios,
      selectScenario,
      selectViewpoint,
      authored.sites,
      authored.updatedAt,
      authored.refresh,
      slideshows.decks,
      slideshows.refresh,
      openDeck,
      getCameraPose,
      dispatchCamera
    ]
  )

  // Memoized like authorContext above, for the same reason: this feeds
  // SlideshowModal, which otherwise recomputes its sandboxed srcDoc and
  // re-subscribes its keyboard/message listeners on every liveZoom frame.
  const closeSlideshow = useCallback(() => {
    setSlideshowOpen(false)
    setActiveSlideshowId(null)
  }, [])
  const slideshowControls = useMemo<SlideshowControlsState>(
    () => ({
      decks: slideshows.decks,
      activeDeckId: activeSlideshowId,
      open: slideshowOpen,
      onOpenDeck: openDeck,
      onClose: closeSlideshow
    }),
    [slideshows.decks, activeSlideshowId, slideshowOpen, openDeck, closeSlideshow]
  )

  const experience = (
    <>
      <SceneHost onReadinessRefs={handleReadinessRefs}>
        {boot => (
          <Content
            onReadinessRefs={boot.onReadinessRefs}
            disableOcean={boot.disableOcean}
            onLocationChange={handleLocationChange}
            turbineRpm={telemetry.rpm}
            windHeading={telemetry.yawHeading}
            windSpeed={environment?.ignoreWeather ? 0 : (sample?.windSpeed ?? null)}
            waveHeight={environment?.ignoreWeather ? 0 : (sample?.waveHeight ?? null)}
            clockMs={selected}
            pinnedTimeOfDayHour={environment?.timeOfDayHour ?? null}
            precip={environment?.ignoreWeather ? 0 : (sample?.precipitation ?? null)}
            airTemperature={
              environment?.ignoreWeather ? 20 : (sample?.airTemperature ?? null)
            }
            flyTo={flyTo}
            cameraMode={cameraMode}
            fpsSpawn={fpsSpawn}
            shadowFleetVessels={
              layerVisible.shadow ? shadowFleetVessels : NO_VESSELS
            }
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
        )}
      </SceneHost>
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
        ais={activeScenarioDef?.ais ?? null}
        bunkering={activeScenarioDef?.bunkering ?? null}
        splat={activeScenarioDef?.splat ?? null}
        process={activeScenarioDef?.process ?? null}
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
            scenarios: visibleScenarios,
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
            },
            slideshows: slideshowControls
          } satisfies ScenarioControlsState
        }
      />
      {/* Debug controls: kept, but collapsed by default and out of the way
          (top-right; the conditions HUD stacks below it). */}
      <Leva collapsed />
    </>
  )

  if (authorSlot == null) return experience

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <aside
        style={{
          flex: `0 0 ${AUTHOR_DOCK_WIDTH}px`,
          height: '100%',
          minWidth: 0,
          overflow: 'hidden'
        }}
      >
        {authorSlot(authorContext)}
      </aside>
      {/* translateZ(0): containing block for the fixed visitor overlay — see
          TwinExperienceProps.authorSlot. */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          height: '100%',
          minWidth: 0,
          overflow: 'hidden',
          transform: 'translateZ(0)'
        }}
      >
        {experience}
      </div>
    </div>
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
      href='/'
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
        color: '#13294b'
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
          src='/public/brand/huma-favicon.png'
          alt='Huma'
          style={{ width: '1.25rem', height: '1.25rem' }} // size-5
        />
      </div>
      <div
        style={{
          display: 'grid',
          flex: 1,
          textAlign: 'left',
          lineHeight: 1.25
        }}
      >
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
  </div>
)
