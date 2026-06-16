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
      },
      // Ship 0 at the site anchor (ENU offsets ~0, waterline ~26 m). FPS: stand
      // ON the deck (spawn raycasts to the deck surface and rides the heave).
      {
        id: 'ship',
        label: 'Ship',
        aimOffsetENU: [0, -10, 20],
        distance: 300,
        pitchDeg: -15,
        spawn: { platform: 'ship', offsetENU: [0, 0, 10], headingDeg: 345 }
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
      {
        id: 'underwater',
        label: 'Underwater',
        aimOffsetENU: [30, 0, -8],
        distance: 50,
        pitchDeg: 8,
        spawn: { offsetENU: [77, -8.8, 21.3], headingDeg: 279.2, pitchDeg: -10.5 }
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
  {
    id: 'waste-handling',
    label: 'Waste Handling',
    viewpoints: [
      // TODO real site — placeholder: Klemetsrud waste-to-energy plant, Oslo.
      {
        id: 'overview',
        label: 'Overview',
        longitude: 10.8087,
        latitude: 59.8328,
        height: 200,
        distance: 1200,
        pitchDeg: -35
      },
      {
        id: 'plant',
        label: 'Plant',
        longitude: 10.8065,
        latitude: 59.8341,
        height: 190,
        distance: 300
      }
    ]
  },
  {
    id: 'sewer-system',
    label: 'Sewer System',
    viewpoints: [
      // TODO real site — placeholder: VEAS treatment plant, Slemmestad.
      {
        id: 'overview',
        label: 'Overview',
        longitude: 10.4936,
        latitude: 59.7833,
        height: 60,
        distance: 1000,
        pitchDeg: -30
      },
      {
        id: 'outfall',
        label: 'Outfall',
        longitude: 10.505,
        latitude: 59.787,
        height: 20,
        distance: 350
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
  {
    id: 'forestry',
    label: 'Forestry',
    viewpoints: [
      // TODO real sites — placeholders: Mjøsa-area forest + Moelv sawmill.
      {
        id: 'harvester',
        label: 'Mobile',
        longitude: 10.75,
        latitude: 60.96,
        height: 300,
        distance: 500,
        pitchDeg: -30
      },
      {
        id: 'sawmill',
        label: 'Sawmill',
        longitude: 10.69,
        latitude: 60.93,
        height: 140,
        distance: 600,
        headingDeg: 135
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
      {
        id: 'platform',
        label: 'Platform',
        aimOffsetENU: [0, 0, 25],
        distance: 400,
        pitchDeg: -10,
        // Deterministic absolute spawn captured in-scene (camera 'Dump view'),
        // converted ECEF → geodetic + compass heading/pitch. Avoids the deck
        // ride/raycast that stranded the camera at the orbit position.
        spawn: {
          longitude: 13.199772,
          latitude: 67.499986,
          height: 55.06,
          headingDeg: 165.5,
          pitchDeg: -1.5
        }
      },
      {
        id: 'overview',
        label: 'Overview',
        // Slightly different aim height than 'platform' so the switch re-flies.
        aimOffsetENU: [0, 0, 27],
        distance: 1500,
        pitchDeg: -25
      }
    ]
  },
  {
    id: 'skibladnir',
    label: 'Skibladnir',
    viewpoints: [
      // TODO real site — placeholder: Lake Mjøsa off Gjøvik.
      {
        id: 'overview',
        label: 'Overview',
        longitude: 10.7,
        latitude: 60.795,
        height: 130,
        distance: 800,
        pitchDeg: -25
      },
      {
        id: 'deck',
        label: 'Deck',
        longitude: 10.702,
        latitude: 60.796,
        height: 128,
        distance: 150,
        pitchDeg: -10
      }
    ]
  }
]
