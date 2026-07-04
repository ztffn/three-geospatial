// ENU↔world (ECEF) conversion for site-anchored content: resolves a site's
// WGS84 anchor to ECEF, converts positions between the site's local east/
// north/up frame and world coordinates, builds placement matrices for
// SiteTransform, and inverts a live camera pose into SiteViewpoint fields
// (viewpoint capture). Client-side only; the pure schema lives in types.ts.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three'

import { Geodetic, radians } from '@takram/three-geospatial'

import { enuBasis } from '../../../storybook-webgpu/src/ocean/enu'
import type { SiteAnchor, SiteTransform, SiteViewpoint } from './types'

/** The site anchor's ECEF position (fresh allocation unless `out` given). */
export function anchorToECEF(
  anchor: SiteAnchor,
  out = new Vector3()
): Vector3 {
  return new Geodetic(
    radians(anchor.longitude),
    radians(anchor.latitude),
    anchor.height ?? 0
  ).toECEF(out)
}

/** A site-local ENU position (metres east/north/up from the anchor) in ECEF. */
export function enuToECEF(
  anchor: SiteAnchor,
  positionENU: [number, number, number],
  out = new Vector3()
): Vector3 {
  const origin = anchorToECEF(anchor, out)
  const { east, north, up } = enuBasis(origin)
  return origin
    .addScaledVector(east, positionENU[0])
    .addScaledVector(north, positionENU[1])
    .addScaledVector(up, positionENU[2])
}

/** Rotation aligning local XYZ with the anchor's east/north/up axes. */
export function enuFrameQuaternion(
  anchor: SiteAnchor,
  out = new Quaternion()
): Quaternion {
  const origin = anchorToECEF(anchor)
  const { east, north, up } = enuBasis(origin)
  return out.setFromRotationMatrix(new Matrix4().makeBasis(east, north, up))
}

/** An ECEF point as [east, north, up] metres from the anchor. */
export function ecefToENUOffset(
  anchor: SiteAnchor,
  ecef: [number, number, number]
): [number, number, number] {
  const origin = anchorToECEF(anchor)
  const { east, north, up } = enuBasis(origin)
  const offset = new Vector3(...ecef).sub(origin)
  return [offset.dot(east), offset.dot(north), offset.dot(up)]
}

// A live orbit-camera pose (ECEF eye + orbit target, as reported by the
// scene's getCameraPose).
export interface CameraPose {
  position: [number, number, number]
  target: [number, number, number]
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * Invert a live orbit pose into SiteViewpoint camera fields, matching the
 * scene's PointOfView convention exactly (decompose: eye = target − v·d with
 * v = (east·cosθ + north·sinθ)·cosφ + up·sinφ, ENU taken AT THE TARGET,
 * heading measured from local east): heading = atan2(north·dir, east·dir),
 * pitch = asin(up·dir), dir = normalized eye→target. Values rounded to 0.1
 * like the hand-captured entries in ui/scenarios.ts.
 */
export function poseToViewpointFields(
  anchor: SiteAnchor,
  pose: CameraPose
): Pick<SiteViewpoint, 'targetENU' | 'distance' | 'headingDeg' | 'pitchDeg'> {
  const eye = new Vector3(...pose.position)
  const target = new Vector3(...pose.target)
  const direction = target.clone().sub(eye)
  const distance = direction.length()
  direction.normalize()
  const { east, north, up } = enuBasis(target)
  const heading = Math.atan2(north.dot(direction), east.dot(direction))
  const pitch = Math.asin(Math.min(1, Math.max(-1, up.dot(direction))))
  const [e, n, u] = ecefToENUOffset(anchor, pose.target)
  return {
    targetENU: [round1(e), round1(n), round1(u)],
    distance: round1(distance),
    headingDeg: round1((heading * 180) / Math.PI),
    pitchDeg: round1((pitch * 180) / Math.PI)
  }
}

// A view is stored relative to its scenario's anchor, and selecting it
// re-centres the world (ocean/terrain) there — beyond this range the world
// would load in the wrong place, so captures must be refused, not stored.
export const MAX_CAPTURE_ANCHOR_DISTANCE = 50_000 // m

/** Metres between a pose's aim point and an anchor. */
export function poseAnchorDistance(
  anchor: SiteAnchor,
  pose: CameraPose
): number {
  return new Vector3(...pose.target).distanceTo(anchorToECEF(anchor))
}

/** Why a pose can't be captured against this anchor, or null when it can.
 * Phrased in product terms — the anchor belongs to `scenarioLabel`'s views. */
export function capturePoseAnchorError(
  anchor: SiteAnchor,
  pose: CameraPose,
  scenarioLabel: string
): string | null {
  const distance = poseAnchorDistance(anchor, pose)
  if (distance <= MAX_CAPTURE_ANCHOR_DISTANCE) return null
  return (
    `You're looking ${Math.round(distance / 1000)} km from the views of ` +
    `'${scenarioLabel}' — create a new scenario for this location instead.`
  )
}

/** The pose's aim point as a site anchor: its geodetic lon/lat at SEA LEVEL
 * (height 20, like every locationPreset) — the ocean surface is placed at
 * anchor height, so a terrain-height anchor would lift and flood the world.
 * Used to mint the anchor for a scenario's first captured view. */
export function poseTargetToAnchor(pose: CameraPose): SiteAnchor {
  const geodetic = new Geodetic().setFromECEF(new Vector3(...pose.target))
  return {
    longitude: (geodetic.longitude * 180) / Math.PI,
    latitude: (geodetic.latitude * 180) / Math.PI,
    height: 20,
    frame: 'wgs84-enu'
  }
}

/**
 * Full world placement for a SiteTransform: ECEF position, rotation composed
 * as (ENU frame ∘ local rotation), and scale. Local rotation comes from the
 * transform's quaternion if present, else its euler degrees (XYZ order about
 * the ENU east/north/up axes), else identity.
 */
export function siteTransformToMatrix(
  anchor: SiteAnchor,
  transform: SiteTransform,
  out = new Matrix4()
): Matrix4 {
  const position = enuToECEF(anchor, transform.positionENU)
  const rotation = enuFrameQuaternion(anchor)
  if (transform.quaternion != null) {
    rotation.multiply(new Quaternion(...transform.quaternion))
  } else if (transform.rotationEulerDeg != null) {
    const [x, y, z] = transform.rotationEulerDeg
    rotation.multiply(
      new Quaternion().setFromEuler(
        new Euler(radians(x), radians(y), radians(z), 'XYZ')
      )
    )
  }
  const scale =
    typeof transform.scale === 'number'
      ? new Vector3().setScalar(transform.scale)
      : transform.scale != null
        ? new Vector3(...transform.scale)
        : new Vector3(1, 1, 1)
  return out.compose(position, rotation, scale)
}
