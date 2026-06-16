// TwinFishSchool.tsx — Drop-in fish schools for the twin scene. `TwinFishSchools`
// owns the "Fish" leva folder and drops one school per scenario anchor; the twin
// just renders <TwinFishSchools anchors=… seaLevelOffset=… seabedDepth=… ready=… />.
// The fish system assumes local +Y up, so each site builds an ENU frame at its
// anchor (globe-up, no ocean scale). Schools HANG from just below the surface
// (known seaLevelOffset) down to a band bottom clamped above the known seabed —
// no terrain raycast; both references come straight from the ocean/cable controls.

import { Suspense, useMemo, type FC } from 'react'
import { Quaternion, Vector3 } from 'three'
import { useControls } from 'leva'

import { FishSchool } from '../fish/FishSchool'
import { enuBasis } from './enu'

// Tuned in the standalone fish/FishSchool story (Export settings). Units are
// metres here (the twin's world scale), so radii read as a real school footprint.
const LARGE_SCHOOL = {
  textureUrl: '/public/fish/largefish-atlas-left.png',
  maxCount: 64,
  count: 5,
  fishLength: 12,
  fishHeight: 3.4,
  fishWidthSegments: 12,
  radiusX: 220,
  radiusZ: 160,
  depth: 10.5,
  size: 0.25,
  speed: 1.0,
  tailBeat: 4,
  tailAmplitude: 0.05,
  flock: 0.18,
  flockScale: 0.045,
  flockGroups: 4,
  metalness: 0,
  roughness: 0.4,
  wander: 0.35,
  turnRate: 1,
  currentX: 0.4,
  currentZ: 0,
  opacity: 1
} as const

const SMALL_SCHOOL = {
  textureUrl: '/public/fish/smallfish-atlas-left.png',
  maxCount: 512,
  count: 275,
  fishLength: 4,
  fishHeight: 1.15,
  fishWidthSegments: 8,
  radiusX: 240,
  radiusZ: 180,
  depth: 18.5,
  size: 0.25,
  speed: 3.0,
  tailBeat: 10,
  tailAmplitude: 0.09,
  flock: 1,
  flockScale: 0.045,
  flockGroups: 5,
  metalness: 0,
  roughness: 0.4,
  wander: 0.35,
  turnRate: 1.4,
  currentX: 0.4,
  currentZ: 0,
  opacity: 1
} as const

// Keep fish clear of the surface and the seabed (metres).
const TOP_MARGIN = 3
const BOTTOM_MARGIN = 2

interface SiteFishSchoolProps {
  anchor: Vector3
  seaLevelOffset: number
  /** How deep below the surface the school's bottom may reach (metres). */
  bandDepth: number
  /** Known seabed depth below the surface (the cables' value) — a hard clamp so
   *  the band never reaches the floor even if bandDepth is set deeper. */
  seabedDepth: number
  brightness: number
  seed: number
  debug: boolean
}

// One site's schools, pinned to an ECEF anchor and aligned to the globe's up.
// Both schools fill the same band: top ~TOP_MARGIN below the surface, bottom at
// `bandDepth` (clamped above the known seabed). No raycast — surface and seabed
// both come from the ocean/cable controls.
const SiteFishSchool: FC<SiteFishSchoolProps> = ({
  anchor,
  seaLevelOffset,
  bandDepth,
  seabedDepth,
  brightness,
  seed,
  debug
}) => {
  const { position, quaternion } = useMemo(() => {
    const { up } = enuBasis(anchor)
    // Group origin at the SURFACE; the per-school offset hangs fish below it.
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up)
    const p = anchor.clone().addScaledVector(up, seaLevelOffset)
    return {
      position: [p.x, p.y, p.z] as [number, number, number],
      quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number]
    }
  }, [anchor, seaLevelOffset])

  // Band bottom = the requested depth, never past the known seabed.
  const bottom = Math.max(
    TOP_MARGIN + 2,
    Math.min(bandDepth, seabedDepth - BOTTOM_MARGIN)
  )
  // FishSchool renders its volume raised to [0, 2·depth] above its origin, so a
  // half-height of (bottom − TOP_MARGIN)/2 with the origin dropped to `bottom`
  // puts the top at TOP_MARGIN below the surface and the bottom at `bottom`.
  const depth = (bottom - TOP_MARGIN) / 2
  const offset: [number, number, number] = [0, -bottom, 0]

  return (
    <group position={position} quaternion={quaternion}>
      <FishSchool
        {...SMALL_SCHOOL}
        depth={depth}
        position={offset}
        seed={20 + seed}
        brightness={brightness}
        debug={debug}
      />
      <FishSchool
        {...LARGE_SCHOOL}
        depth={depth}
        position={offset}
        seed={10 + seed}
        brightness={brightness}
        debug={debug}
      />
    </group>
  )
}

export interface TwinFishSchoolsProps {
  /** ECEF anchors, one underwater school per entry (the scenario sites). */
  anchors: Vector3[]
  /** Sea-surface height above each anchor, metres (the ocean seaLevelOffset). */
  seaLevelOffset: number
  /** Known seabed depth below the surface (the cables' seabedDepth) — clamps the
   *  fish band so it never reaches the floor. */
  seabedDepth: number
  /** Staged-load gate — pass `!disableOcean` so fish don't load during stage 1. */
  ready?: boolean
}

// Drop-in: owns the "Fish" leva folder (enable + emissive + debug) and renders
// one school per anchor. The vertical band is derived from `seabedDepth` (no
// manual depth knob). Always mounted (so the leva folder is stable); gates the
// actual fish on `enabled && ready` internally.
export const TwinFishSchools: FC<TwinFishSchoolsProps> = ({
  anchors,
  seaLevelOffset,
  seabedDepth,
  ready = true
}) => {
  const fish = useControls('Fish', {
    enabled: { value: true, label: 'Fish schools' },
    depth: {
      value: 18,
      min: 4,
      max: 120,
      step: 1,
      label: 'Band depth below surface (m)'
    },
    brightness: { value: 0.4, min: 0, max: 1.5, step: 0.01, label: 'Brightness' },
    debug: { value: false, label: 'Show bounds' }
  })

  if (!fish.enabled || !ready) {
    return null
  }

  return (
    <>
      {anchors.map((anchor, index) => (
        <Suspense key={anchor.x} fallback={null}>
          <SiteFishSchool
            anchor={anchor}
            seaLevelOffset={seaLevelOffset}
            bandDepth={fish.depth}
            seabedDepth={seabedDepth}
            brightness={fish.brightness}
            seed={index * 100}
            debug={fish.debug}
          />
        </Suspense>
      ))}
    </>
  )
}
