// Shared East-North-Up tangent-frame helpers for placing objects on the WGS84
// globe. Used by the story scene (turbine farm, wind arrow) and by standalone
// scene modules (ShipModel) — extracted from GlobeWaterproOcean-Story so those
// modules don't import the story (which would be circular). Fresh allocations
// per call; hoist results if calling per frame.

import { MathUtils, Vector3 } from 'three'

import { Ellipsoid } from '@takram/three-geospatial'

/** Local east/north/up basis at an ECEF point (fresh allocation per call). */
export function enuBasis(point: Vector3): {
  east: Vector3
  north: Vector3
  up: Vector3
} {
  const east = new Vector3()
  const north = new Vector3()
  const up = new Vector3()
  Ellipsoid.WGS84.getEastNorthUpVectors(point, east, north, up)
  return { east, north, up }
}

/** Horizontal unit vector for a compass bearing (0 = North, 90 = East) in the
 * given ENU basis. east/north are orthonormal, so the result is unit-length. */
export function bearingVector(
  deg: number,
  east: Vector3,
  north: Vector3
): Vector3 {
  const rad = MathUtils.degToRad(deg)
  return north
    .clone()
    .multiplyScalar(Math.cos(rad))
    .addScaledVector(east, Math.sin(rad))
}
