// Karmøy offshore-wind site expressed in the SiteDefinition schema: the seed/
// default the author-mode site manifest starts from, converted mechanically
// from the two Karmøy-anchored entries in ui/scenarios.ts. NOT yet consumed by
// the 3D runtime — ui/scenarios.ts remains the live catalogue until gravis
// Phase 2 wires SiteRuntime; this file declares the target shape.
//
// Known conversion gaps, to reconcile when Phase 1 executes for real:
// - Viewpoint `headingRefYaw` (turbine-yaw-relative heading) and per-viewpoint
//   FPS spawns have no SiteViewpoint equivalent yet; they stay authoritative
//   in ui/scenarios.ts.
// - `layers` is empty: ship/turbine/cable placement is hardcoded in
//   GlobeWaterproOcean-Story.tsx (constants + Leva folders). Extracting it
//   into SiteModelLayer entries is the gravis-plan Phase 2 seam.

import type { SiteDefinition } from './types'

export const KARMOY_SITE: SiteDefinition = {
  id: 'karmoy',
  label: 'Karmøy Wind Farm',
  description:
    'Offshore floating wind site ~10 km west of Karmøy (Utsira Nord area, ' +
    'Norway): 15-turbine farm, substation vessel with baked inter-array ' +
    'cables, and the ship-to-ship wax bunkering operation.',
  // Matches the 'Karmøy' locationPreset the scene anchors this site to.
  anchor: {
    longitude: 5.206866,
    latitude: 59.427348,
    height: 20,
    frame: 'wgs84-enu'
  },
  layers: [],
  scenarios: [
    {
      id: 'karmoy',
      label: 'Karmøy Wind Farm',
      summary: '15-turbine floating farm; rotor spin and hero cover toggles.',
      defaultViewpointId: 'overview',
      settings: [
        { id: 'rotorSpin', label: 'Rotor spin', defaultOn: true },
        { id: 'cover', label: 'Cover', defaultOn: true }
      ],
      viewpoints: [
        // Overview has no authored aim in scenarios.ts (the rig flies to its
        // default destination, the hero turbine nacelle) — anchor-origin here.
        { id: 'overview', label: 'Overview', targetENU: [0, 0, 0], distance: 400 },
        {
          id: 'nacelle',
          label: 'Nacelle',
          targetENU: [463.9, 463.9, 82.1],
          distance: 16.8,
          headingDeg: 286.6,
          pitchDeg: -4.9
        },
        {
          id: 'hregg',
          label: 'Hregg',
          targetENU: [464.1, 463.5, 82.1],
          distance: 4.2,
          headingDeg: 238.6,
          pitchDeg: -2.6
        },
        {
          id: 'hregg-close',
          label: 'Hregg Close',
          targetENU: [464.1, 463.5, 82.1],
          distance: 2.2,
          headingDeg: 270.3,
          pitchDeg: -8.2
        },
        {
          id: 'underwater',
          label: 'Underwater',
          targetENU: [459, 472, 51],
          distance: 232,
          headingDeg: 189.4,
          pitchDeg: 8
        }
      ]
    },
    {
      id: 'bunkering',
      label: 'Bunkering',
      summary:
        'Ship-to-ship transfer of Caera wax cubes at the substation vessel.',
      defaultViewpointId: 'overview',
      viewpoints: [
        {
          id: 'overview',
          label: 'Overview',
          targetENU: [-13.3, -0.8, 30.5],
          distance: 95.1,
          headingDeg: 317.2,
          pitchDeg: -7.1
        },
        {
          id: 'transfer',
          label: 'Transfer',
          targetENU: [-9.7, -14.3, 16.9],
          distance: 82,
          headingDeg: 310.1,
          pitchDeg: -50.9
        },
        {
          id: 'underwater',
          label: 'Underwater',
          targetENU: [19.8, -2.7, 18.8],
          distance: 80.5,
          headingDeg: 274.1,
          pitchDeg: -2.8
        },
        {
          id: 'mosaic',
          label: 'Mosaic',
          targetENU: [0.4, 1, 25.8],
          distance: 20.8,
          headingDeg: 123.5,
          pitchDeg: -20.7
        }
      ]
    }
  ],
  annotations: []
}
