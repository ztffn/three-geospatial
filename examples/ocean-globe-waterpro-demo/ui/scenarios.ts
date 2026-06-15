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
  // baked cables pinned to it do NOT re-centre (ship / underwater viewpoints).
  aimOffsetENU?: [number, number, number]
  // Landing orbit distance (m). Omitted → keep the current zoom.
  distance?: number
  // Camera compass heading / pitch at landing. Omitted → scene defaults
  // (heading 180, pitch -20). Positive pitch lands the camera BELOW the aim
  // looking up — used for the underwater viewpoint.
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
      // No aim → the rig's default destination, the hero turbine nacelle.
      // FPS: hub-level beside a grid turbine NE of the anchor (pose captured
      // in-scene via the camera dump; converted ECEF → anchor-ENU).
      {
        id: 'turbine',
        label: 'Turbine',
        distance: 400,
        spawn: { offsetENU: [461.6, 462.0, 82.0], headingDeg: 43, pitchDeg: 0.5 }
      },
      // Ship 0 sits at the site anchor (ENU offsets ~0, waterline ~26 m).
      // FPS: stand ON the deck (spawn raycasts down to the deck surface and
      // rides the hull's heave/tilt); offset is from the live ship origin.
      {
        id: 'ship',
        label: 'Ship',
        aimOffsetENU: [0, -10, 20],
        distance: 300,
        pitchDeg: -15,
        spawn: { platform: 'ship', offsetENU: [0, 0, 10], headingDeg: 345 }
      },
      // Aim below the surface near the cable fan; positive pitch puts the
      // camera deeper than the aim, looking up through the water column.
      // Shallow aim/pitch/distance keep the landing well above the ~35 m
      // seabed (camera depth ≈ 8 + 50·sin(8°) ≈ 15 m).
      // FPS: above the dive spot looking down at it (captured via camera
      // dump) — descend with C to go under.
      {
        id: 'underwater',
        label: 'Underwater',
        aimOffsetENU: [30, 0, -8],
        distance: 50,
        pitchDeg: 8,
        spawn: { offsetENU: [77, -8.8, 21.3], headingDeg: 279.2, pitchDeg: -10.5 }
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
  {
    id: 'farm',
    label: 'Farm',
    viewpoints: [
      // TODO real site — placeholder: Jæren farmland, Rogaland.
      {
        id: 'overview',
        label: 'Overview',
        longitude: 5.66,
        latitude: 58.78,
        height: 60,
        distance: 900,
        pitchDeg: -30
      },
      {
        id: 'yard',
        label: 'Yard',
        longitude: 5.658,
        latitude: 58.781,
        height: 45,
        distance: 250
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
  // Production platform in the open Norwegian Sea (platform-compressed.glb,
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
        spawn: { platform: 'platform', offsetENU: [0, 0, 30] }
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
