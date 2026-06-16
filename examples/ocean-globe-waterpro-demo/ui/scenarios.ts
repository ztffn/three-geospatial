// Scenario catalogue for the digital-twin demo. A Scenario is a themed site
// (wind farm, waste handling, sewer, ...) holding one or more Viewpoints —
// camera presets the ScenarioPanel flies to — plus optional per-scenario
// setting toggles (ids into the host's registry, e.g. rotor spin). Coordinates
// for the non-Karmøy scenarios are PROVISIONAL placeholders; replace per site.

export interface Viewpoint {
  id: string
  label: string
  // Absolute aim (scenarios without a preset anchor). Height is the aim-point
  // ellipsoid height (m); setting it marks the aim as deliberately placed,
  // unlocking exact close landings at turbine-free sites.
  longitude?: number
  latitude?: number
  height?: number
  // OR a camera-only aim offset (m, [east, north, up]) from the scenario's
  // anchor. Keeps the location target untouched, so the turbine farm and the
  // baked cables pinned to it do NOT re-centre (ship / bunkering viewpoints).
  aimOffsetENU?: [number, number, number]
  // Landing orbit distance (m). Omitted → keep the current zoom.
  distance?: number
  // Camera compass heading / pitch at landing. Omitted → scene defaults
  // (heading 180, pitch -20). Positive pitch lands the camera BELOW the aim
  // looking up (e.g. a near-surface aim looking up through the water column).
  headingDeg?: number
  pitchDeg?: number
  // First-person spawn for THIS viewpoint (FPS camera mode). Omitted → derived
  // from the viewpoint itself: its lon/lat at eye level, or its aimOffsetENU.
  spawn?: FpsSpawn
}

// First-person spawn for the WASD camera mode: where you "stand" when
// switching to (or arriving at) a viewpoint in FPS view. Either absolute
// (longitude/latitude/height = eye height) or offsetENU metres from the
// scenario's preset anchor. `platform` (a scene registry id: 'ship' |
// 'patrolship' | 'platform') makes offsetENU relative to that structure's
// LIVE deck frame instead — the FPS rig spawns on it (raycast to the deck
// surface) and rides its motion. Heading/pitch are the initial look direction.
export interface FpsSpawn {
  longitude?: number
  latitude?: number
  height?: number
  offsetENU?: [number, number, number]
  platform?: string
  headingDeg?: number
  pitchDeg?: number
}

// AIS-style vessel readings shown in the inspector card (top-left) when the
// scenario is active — shaped like a live AIS message so a real feed
// (BarentsWatch / aisstream) can replace these static values later.
export interface AisReadings {
  vesselName: string
  navigationalStatus: string
  speedKn: number
  courseDeg: number
  headingDeg: number
  rateOfTurnDegMin: number
  draughtM: number
}

// Static demo metrics for the bunkering scenario's two-vessel inspector
// (labelled as such in the panel). The bunker tanker's fuel transfer + the
// substation vessel's battery/charging. `collectedMW` is NOT here — the panel
// shows it live from the modelled farm output (count × per-turbine).
export interface BunkeringReadings {
  // Caera wax carrier → receiving vessel. The wax ships and stores as stable
  // solid cubes (crane-transferred) — it is only melted later, at the customer
  // site, to feed the hydrocracker.
  product: string
  cubesTransferred: number
  cubesTotal: number
  transferRateCubesH: number // crane transfer rate
  cubeVolumeM3: number // per-cube volume
  cubeMassT: number // per-cube mass
  // Substation vessel (Ship 1): battery + grid export.
  batterySoc: number // state of charge, 0..1
  batteryChargeMW: number
  batteryCapacityMWh: number
  busKv: number
}

export interface Scenario {
  id: string
  label: string
  // Scene location-preset name anchoring this scenario. Keeps the location
  // (and everything pinned to it) stable across this scenario's viewpoints.
  preset?: string
  // Turbine farm size at this site (default 0 — scenarios are not wind farms).
  turbines?: number
  // Static AIS readings for vessel scenarios; replaces the turbine inspector.
  ais?: AisReadings
  // Static demo two-vessel metrics for the bunkering scenario inspector.
  bunkering?: BunkeringReadings
  // Setting toggles shown when this scenario is active; ids resolve against
  // the registry the host passes in ScenarioControlsState.settings.
  settings?: string[]
  // First entry is the default viewpoint a scenario click flies to.
  viewpoints: Viewpoint[]
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'karmoy',
    label: 'Karmøy Wind Farm',
    preset: 'Karmøy',
    turbines: 15,
    settings: ['rotorSpin', 'cover'],
    viewpoints: [
      // Default landing / overview — no aim, so the rig flies to its default
      // destination (the hero turbine nacelle) at 400 m. FPS: hub-level beside a
      // grid turbine NE of the anchor (pose captured in-scene, ECEF→anchor-ENU).
      {
        id: 'overview',
        label: 'Overview',
        distance: 400,
        spawn: { offsetENU: [461.6, 462.0, 82.0], headingDeg: 43, pitchDeg: 0.5 }
      },
      // Progressive close-ups of the grid turbine NE of the anchor (captured
      // in-scene via camera 'Dump view', ECEF → Karmøy-anchor ENU; camera-only
      // aim at the nacelle ~82 m up, so the farm and cables stay pinned).
      {
        id: 'nacelle',
        label: 'Nacelle',
        aimOffsetENU: [463.9, 463.9, 82.1],
        distance: 16.8,
        headingDeg: 286.6,
        pitchDeg: -4.9
      },
      {
        id: 'hregg',
        label: 'Hregg',
        aimOffsetENU: [464.1, 463.5, 82.1],
        distance: 4.2,
        headingDeg: 238.6,
        pitchDeg: -2.6
      },
      {
        id: 'hregg-close',
        label: 'Hregg Close',
        aimOffsetENU: [464.1, 463.5, 82.1],
        distance: 2.2,
        headingDeg: 270.3,
        pitchDeg: -8.2
      },
      // Underwater at the base of the same grid turbine — aim below the surface
      // at the turbine's E/N (~8 m down, on the monopile foundation); positive
      // pitch puts the camera deeper than the aim, looking up the column toward
      // the surface. Heuristic placement (no in-scene capture) — nudge to taste.
      {
        id: 'underwater',
        label: 'Underwater',
        aimOffsetENU: [464, 463, -8],
        distance: 35,
        headingDeg: 270,
        pitchDeg: 8
      }
    ]
  },
  // Ship-to-ship bunkering at the Karmøy site: the former Karmøy 'underwater'
  // viewpoint lifted out into its own scenario button. Keeps the Karmøy preset
  // and turbine count so the farm and the inter-array cables that bake into the
  // substation vessel (Ship 1) stay identical — but NOT the rotor-spin/cover
  // toggles, which belong to the wind-farm scenario, not bunkering.
  {
    id: 'bunkering',
    label: 'Bunkering',
    preset: 'Karmøy',
    turbines: 15,
    bunkering: {
      product: 'Caera wax',
      cubesTransferred: 312,
      cubesTotal: 500,
      transferRateCubesH: 24,
      cubeVolumeM3: 1,
      cubeMassT: 0.9,
      batterySoc: 0.68,
      batteryChargeMW: 5.4,
      batteryCapacityMWh: 20,
      busKv: 66
    },
    viewpoints: [
      // Default landing — establishing view of the two vessels alongside
      // (all bunkering poses captured in-scene via camera 'Dump view',
      // ECEF → Karmøy-anchor ENU; camera-only aim, ships/cables stay put).
      {
        id: 'overview',
        label: 'Overview',
        aimOffsetENU: [-13.3, -0.8, 30.5],
        distance: 95.1,
        headingDeg: 317.2,
        pitchDeg: -7.1
      },
      // The transfer itself — looking down steeply onto the crane lift.
      {
        id: 'transfer',
        label: 'Transfer',
        aimOffsetENU: [-9.7, -14.3, 16.9],
        distance: 82,
        headingDeg: 310.1,
        pitchDeg: -50.9,
        spawn: { offsetENU: [77, -8.8, 21.3], headingDeg: 279.2, pitchDeg: -10.5 }
      },
      // Underwater subview — aim below the surface near the cable fan; positive
      // pitch puts the camera deeper than the aim, looking up through the water
      // column. FPS spawns above the dive spot looking down — descend with C.
      // (Recaptured in-scene via camera 'Dump view', ECEF → Karmøy-anchor ENU.)
      {
        id: 'underwater',
        label: 'Underwater',
        aimOffsetENU: [19.8, -2.7, 18.8],
        distance: 80.5,
        headingDeg: 274.1,
        pitchDeg: -2.8,
        spawn: { offsetENU: [100.1, -8.5, 22.7], headingDeg: 274.1, pitchDeg: -2.8 }
      },
      // Mosaic — tight close-up on the wax-cube cargo.
      {
        id: 'mosaic',
        label: 'Mosaic',
        aimOffsetENU: [0.4, 1, 25.8],
        distance: 20.8,
        headingDeg: 123.5,
        pitchDeg: -20.7
      }
    ]
  },
  // Waste-handling facility on/near Karmøy island. Anchored at the 'Waste
  // Handling' preset, where site_compressed.glb sits (static land model, placed
  // via the 'Waste site' leva folder). Camera-only aims at the kiln, so the site
  // stays pinned. Aims + FPS spawn captured in-scene (camera 'Dump view', ECEF →
  // anchor ENU). The shared FPV spawn (~kiln-top height, free-fly) is repeated on
  // every viewpoint so entering FPS lands at the site, not the sea-level derive.
  {
    id: 'waste-handling',
    label: 'Waste Handling',
    preset: 'Waste Handling',
    viewpoints: [
      {
        id: 'overview',
        label: 'Overview',
        aimOffsetENU: [-24.4, -27.5, 45.9],
        distance: 219,
        headingDeg: 108,
        pitchDeg: -25,
        spawn: { offsetENU: [-39.6, -5.2, 69.6], headingDeg: 145.8, pitchDeg: -41.3 }
      },
      // Captured close-up on the kiln (Kiln_top), looking down.
      {
        id: 'mosaic',
        label: 'Mosaic',
        aimOffsetENU: [-24.4, -27.5, 45.9],
        distance: 55,
        headingDeg: 108,
        pitchDeg: -40.2,
        spawn: { offsetENU: [-39.6, -5.2, 69.6], headingDeg: 145.8, pitchDeg: -41.3 }
      },
      // Orbit pivots on the Carbio unit (picked in-scene: Carbio_right) rather
      // than the kiln; same captured angle/distance.
      {
        id: 'carbio',
        label: 'Carbio',
        aimOffsetENU: [-38.1, -11.1, 68.8],
        distance: 44.3,
        headingDeg: 159.4,
        pitchDeg: -47.8,
        spawn: { offsetENU: [-39.6, -5.2, 69.6], headingDeg: 145.8, pitchDeg: -41.3 }
      }
    ]
  },
  // Offshore wind-turbine installation rig (hregg_pivot.glb, InstallationRig.tsx),
  // anchored at the 'Utsira Nord' offshore preset. The Installation panel
  // (DigitalTwinUI) plays its 10 install-phase clips + the operating idle loop.
  {
    id: 'turbine-install',
    label: 'Turbine Installation',
    preset: 'Utsira Nord',
    // East/North aim offsets match the rig's RIG_TILE_OFFSET_M (250 m) so the
    // camera centres on the rig after it's nudged off the ocean grid seam. The
    // up component aims well above the ~29 m sea surface so the orbit pivot
    // frames the rig's deck/mast, not the waterline.
    viewpoints: [
      // Close on the rig, framing the mast/beam during the install sequence.
      {
        id: 'rig',
        label: 'Rig',
        aimOffsetENU: [250, 250, 55],
        distance: 320,
        pitchDeg: -8
      },
      {
        id: 'overview',
        label: 'Overview',
        // Higher aim than 'rig' so the switch re-flies and frames the full mast.
        aimOffsetENU: [250, 250, 75],
        distance: 1100,
        pitchDeg: -28
      }
    ]
  },
  // Patrol ship at sea outside Bodø (patrolship-compressed.glb, anchored at
  // the 'Bodø' scene preset; buoyant — rides the waves).
  {
    id: 'patrol-ship',
    label: 'RV North Star',
    preset: 'Bodø',
    // Static demo readings (labelled as such in the card) for the patrol
    // scene — swap for a live AIS feed when available.
    ais: {
      vesselName: 'RV North Star',
      navigationalStatus: 'Under way using engine',
      speedKn: 11.8,
      courseDeg: 24,
      headingDeg: 222,
      rateOfTurnDegMin: 0,
      draughtM: 7
    },
    viewpoints: [
      {
        id: 'ship',
        label: 'Ship',
        aimOffsetENU: [0, 0, 10],
        distance: 250,
        pitchDeg: -10,
        spawn: { platform: 'patrolship', offsetENU: [0, 0, 10] }
      },
      // Near-surface hull view (captured in-scene, ECEF → Bodø-anchor ENU). Aim
      // nudged off 'ship' so the switch re-flies; FPS spawns off the port side.
      {
        id: 'underwater',
        label: 'Underwater',
        aimOffsetENU: [0, 0, 8],
        distance: 87.8,
        headingDeg: 75.1,
        pitchDeg: -7,
        spawn: { offsetENU: [-84.3, -22.4, 20.8], headingDeg: 75.1, pitchDeg: -7 }
      },
      {
        id: 'overview',
        label: 'Overview',
        // Slightly different aim height than 'ship' so the viewpoint switch
        // re-triggers the fly (same aim would only ease the zoom distance).
        aimOffsetENU: [0, 0, 12],
        distance: 1200,
        pitchDeg: -25
      },
      {
        id: 'barentswatch',
        label: 'BarentsWatch',
        // Top-down regional survey (captured in-scene): ~2,884 km up over
        // central Norway, near-vertical pitch, with the whole coast in frame so
        // the live shadow-fleet AIS markers (shown above 30 km) read across the
        // Barents/Norwegian seas. Camera-only aim — the ship/ocean stay at Bodø.
        // headingDeg 90 = NORTH UP: PointOfView measures heading from local
        // EAST (h = east·cosθ + north·sinθ), so θ=90° points the screen-up
        // vector (which tracks h at top-down) to true north.
        aimOffsetENU: [-252907, -324030, 103687],
        distance: 2884030,
        headingDeg: 90,
        pitchDeg: -82.5
      }
    ]
  },
  // Production platform in the open Norwegian Sea (deepwater_platform_compressed.glb,
  // anchored at the 'Norwegian Sea' scene preset; static structure).
  {
    id: 'platform',
    label: 'Platform',
    preset: 'Norwegian Sea',
    viewpoints: [
      // Default establishing view (captured in-scene, ECEF → anchor ENU).
      {
        id: 'overview',
        label: 'Overview',
        aimOffsetENU: [0, 0, 27],
        distance: 248.6,
        headingDeg: 289.8,
        pitchDeg: -25
      },
      // Close on the deck/superstructure (captured). FPS spawns on the platform.
      {
        id: 'platform',
        label: 'Platform',
        aimOffsetENU: [-3.5, -0.1, 33.1],
        distance: 57.9,
        headingDeg: 258.7,
        pitchDeg: -22.4,
        spawn: { offsetENU: [49, 10.4, 55.1], headingDeg: 258.7, pitchDeg: -22.4 }
      },
      // Underwater at the platform base — aim below the surface, camera deeper
      // looking up the columns. Heuristic (no in-scene capture) — recapture to refine.
      {
        id: 'underwater',
        label: 'Underwater',
        aimOffsetENU: [0, 0, -8],
        distance: 50,
        pitchDeg: 8
      }
    ]
  }
]
