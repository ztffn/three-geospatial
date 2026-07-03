import { Box3, Vector3 } from 'three'
import invariant from 'tiny-invariant'

// The number of spherical harmonics coefficient vectors (each a vec3) for a
// given SH degree. Degree 0 carries only the DC term, which we fold into the
// base color, so it contributes no separate coefficients here.
export function shDegreeToCoefficientCount(degree: 0 | 1 | 2 | 3): number {
  switch (degree) {
    case 0:
      return 0
    case 1:
      return 3
    case 2:
      return 8
    case 3:
      return 15
  }
}

/**
 * Canonical, renderer-agnostic representation of a set of 3D Gaussian splats.
 *
 * The layout intentionally mirrors the `KHR_gaussian_splatting` glTF extension
 * so that the glTF loader and the standalone PLY loader can produce the exact
 * same structure:
 *
 * - `scales` are stored in **log space** (apply `exp` before use), matching both
 *   the glTF `_SCALE` accessor and the PLY `scale_*` properties.
 * - `rotations` are normalized quaternions in **WXYZ** order.
 * - `colors` are final, view-independent RGBA values (the SH DC term and the
 *   opacity sigmoid have already been resolved into these bytes).
 */
export interface GaussianSplatData {
  readonly count: number
  /** `count * 3`, splat centers in local space, XYZ. */
  readonly positions: Float32Array
  /** `count * 3`, log-space scales, XYZ. */
  readonly scales: Float32Array
  /** `count * 4`, normalized quaternions, WXYZ. */
  readonly rotations: Float32Array
  /** `count * 4`, RGBA bytes; alpha is opacity. */
  readonly colors: Uint8Array
  /** Optional view-dependent SH coefficients, `count * coefficientCount * 3`. */
  readonly sh?: Float32Array
  readonly shDegree?: 0 | 1 | 2 | 3
}

export function validateGaussianSplatData(data: GaussianSplatData): void {
  const { count, positions, scales, rotations, colors } = data
  invariant(count >= 0, 'Splat count must be non-negative')
  invariant(positions.length === count * 3, 'positions must be count * 3')
  invariant(scales.length === count * 3, 'scales must be count * 3')
  invariant(rotations.length === count * 4, 'rotations must be count * 4')
  invariant(colors.length === count * 4, 'colors must be count * 4')
  if (data.sh != null) {
    invariant(
      data.shDegree != null,
      'shDegree must be provided when sh is present'
    )
    const coefficients = shDegreeToCoefficientCount(data.shDegree)
    invariant(
      data.sh.length === count * coefficients * 3,
      'sh must be count * coefficientCount * 3'
    )
  }
}

/** Computes the axis-aligned bounding box of the splat centers. */
export function computeSplatBounds(
  data: GaussianSplatData,
  result = new Box3()
): Box3 {
  result.makeEmpty()
  const { count, positions } = data
  const point = new Vector3()
  for (let i = 0; i < count; ++i) {
    point.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
    result.expandByPoint(point)
  }
  return result
}
