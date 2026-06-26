// Loader for Niantic SPZ gaussian-splat files (gzip-wrapped SPZ, e.g. produced by
// spz-js / SuperSplat). Decodes via spz-js into the canonical GaussianSplatData:
// base colour from spz's dequantized DC (its own colour scale, NOT the PLY
// SH_C0), opacity logit → sigmoid alpha, log-space scales passed through, and
// quaternions remapped from spz's XYZW to the WXYZ order GaussianSplatData
// expects. View-dependent SH (degrees 1-3) is carried through, with the RDF→RUB
// coordinate flip applied to the coefficients as a per-coefficient sign table.

import { loadSpz } from 'spz-js'

import {
  shDegreeToCoefficientCount,
  validateGaussianSplatData,
  type GaussianSplatData
} from './GaussianSplatData'

// Sign applied to each SH rest-coefficient (degrees 1-3, indices 0..14) under the
// RDF→RUB coordinate flip (x,y,z) → (x,-y,-z). Each entry is the parity of that
// coefficient's basis monomial in y,z: a monomial odd in (y,z combined) flips
// sign so the evaluated colour stays invariant after positions/rotations flip.
// Order matches the canonical 3DGS SH basis (the same one the node material
// evaluates). Lets SH live in the flipped local frame, so the shader needs no
// per-coefficient handling and reuses the splat-local view direction directly.
const SH_REST_FLIP_YZ = [
  // degree 1: basis ∝ (y, z, x)
  -1, -1, 1,
  // degree 2: basis ∝ (xy, yz, 2zz-xx-yy, xz, xx-yy)
  -1, 1, 1, -1, 1,
  // degree 3: basis ∝ (y(3xx-yy), xyz, y(4zz-xx-yy), z(2zz-3xx-3yy),
  //                     x(4zz-xx-yy), z(xx-yy), x(xx-3yy))
  -1, 1, -1, -1, 1, -1, 1
]

// Zeroth-order SH basis constant. spz-js's `colors` are the RAW SH DC
// coefficients (ply-loader stores f_dc_0..2 verbatim; spz's own 0.15 is only its
// byte-quantization range, NOT the display scale), so the displayable base colour
// is the standard `0.5 + SH_C0 * f_dc` — same as PLYSplatLoader. (Using 0.15 here
// under-saturates the colour toward grey.) View-dependent SH (degrees 1-3) is
// still dropped, so colours are flatter than a full-SH viewer.
const SH_C0 = 0.28209479177387814

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

export interface SpzSplatLoadOptions {
  /**
   * Cap the splat count by uniform-stride subsampling. Omit to keep every splat.
   * A hedge for the single-mesh path, whose CPU sort / data-texture footprint
   * scales with count; multi-million clouds want the (future) GPU-sort path.
   */
  maxSplats?: number
  /**
   * Coordinate / debug mode.
   * - `flipYZ` (default): apply the documented RDF→RUB conversion (negate Y and Z
   *   on positions AND the quaternion). SPZ is defined RUB (= three.js), but
   *   spz-js does NO coordinate conversion, so a PLY(RDF)-derived SPZ arrives in
   *   RDF — its anisotropic covariance is misoriented (explodes) until flipped.
   * - `raw`: no conversion (data as spz-js returns it).
   * - `isotropic`: equal scales + identity rotation → round blobs (diagnostic:
   *   coherent here but exploding elsewhere ⇒ the rotation/orientation is wrong).
   */
  debug?: 'flipYZ' | 'raw' | 'isotropic'
}

/**
 * Decodes a gzip-wrapped SPZ buffer into {@link GaussianSplatData}. The decode
 * (spz-js, pure JS, main thread) expands the compressed stream to full float
 * arrays, so a multi-hundred-MB cloud blocks briefly at load — call off the
 * render loop.
 */
export async function loadSpzSplatData(
  data: ArrayBuffer | Uint8Array,
  options: SpzSplatLoadOptions = {}
): Promise<GaussianSplatData> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const cloud = await loadSpz(bytes)

  const total = cloud.numPoints
  // Uniform stride keeps even spatial coverage when subsampling a tile-ordered
  // cloud (random per-index selection would need an index set over millions).
  const cap = options.maxSplats
  const keep = cap != null && cap < total ? cap : total
  const stride = total / keep

  const positions = new Float32Array(keep * 3)
  const scales = new Float32Array(keep * 3)
  const rotations = new Float32Array(keep * 4)
  const colors = new Uint8Array(keep * 4)

  const srcPos = cloud.positions
  const srcScale = cloud.scales
  const srcRot = cloud.rotations
  const srcColor = cloud.colors
  const srcAlpha = cloud.alphas
  const srcSh = cloud.sh
  const debug = options.debug ?? 'flipYZ'
  // RDF→RUB: negate Y and Z (a 180° rotation about X) on positions and quaternion.
  const fy = debug === 'flipYZ' ? -1 : 1
  const fz = debug === 'flipYZ' ? -1 : 1

  // View-dependent SH (degrees 1-3). Dropped for the `isotropic` diagnostic (its
  // synthetic identity rotation makes view-dependence meaningless) and when the
  // source carries none. `coeffCount` rest-coefficient vec3s per splat, laid out
  // (o*coeffCount + j)*3 + channel — the same order spz-js produces.
  const shDegree = (
    debug === 'isotropic' ? 0 : Math.min(cloud.shDegree, 3)
  ) as 0 | 1 | 2 | 3
  const coeffCount = shDegreeToCoefficientCount(shDegree)
  const hasSh = coeffCount > 0 && srcSh.length >= total * coeffCount * 3
  const sh = hasSh ? new Float32Array(keep * coeffCount * 3) : undefined
  // RDF→RUB per-coefficient sign (flipYZ only); identity otherwise.
  const shFlip = debug === 'flipYZ'

  for (let o = 0; o < keep; ++o) {
    const i = keep === total ? o : Math.floor(o * stride)

    positions[o * 3] = srcPos[i * 3]
    positions[o * 3 + 1] = fy * srcPos[i * 3 + 1]
    positions[o * 3 + 2] = fz * srcPos[i * 3 + 2]

    if (debug === 'isotropic') {
      // Equal log-scales (mean) + identity rotation → round, orientation-free
      // blobs. Coherent here but exploding otherwise ⇒ the rotation is the bug.
      const mean = (srcScale[i * 3] + srcScale[i * 3 + 1] + srcScale[i * 3 + 2]) / 3
      scales[o * 3] = mean
      scales[o * 3 + 1] = mean
      scales[o * 3 + 2] = mean
      rotations[o * 4] = 1
      rotations[o * 4 + 1] = 0
      rotations[o * 4 + 2] = 0
      rotations[o * 4 + 3] = 0
    } else {
      // spz scales are already log-space (axis-flip-invariant), matching
      // GaussianSplatData.
      scales[o * 3] = srcScale[i * 3]
      scales[o * 3 + 1] = srcScale[i * 3 + 1]
      scales[o * 3 + 2] = srcScale[i * 3 + 2]

      // spz rotations are XYZW (w reconstructed last); remap to WXYZ, applying the
      // same Y/Z negation (RDF→RUB quaternion transform is (w,x,y,z)→(w,x,-y,-z)).
      rotations[o * 4] = srcRot[i * 4 + 3]
      rotations[o * 4 + 1] = srcRot[i * 4]
      rotations[o * 4 + 2] = fy * srcRot[i * 4 + 1]
      rotations[o * 4 + 3] = fz * srcRot[i * 4 + 2]
    }

    // SH DC term → displayable base colour; opacity logit → sigmoid alpha.
    colors[o * 4] = Math.round(clamp01(0.5 + SH_C0 * srcColor[i * 3]) * 255)
    colors[o * 4 + 1] = Math.round(
      clamp01(0.5 + SH_C0 * srcColor[i * 3 + 1]) * 255
    )
    colors[o * 4 + 2] = Math.round(
      clamp01(0.5 + SH_C0 * srcColor[i * 3 + 2]) * 255
    )
    colors[o * 4 + 3] = Math.round(clamp01(sigmoid(srcAlpha[i])) * 255)

    if (sh != null) {
      for (let j = 0; j < coeffCount; ++j) {
        const sign = shFlip ? SH_REST_FLIP_YZ[j] : 1
        const dst = (o * coeffCount + j) * 3
        const src = (i * coeffCount + j) * 3
        sh[dst] = sign * srcSh[src]
        sh[dst + 1] = sign * srcSh[src + 1]
        sh[dst + 2] = sign * srcSh[src + 2]
      }
    }
  }

  const result: GaussianSplatData =
    sh != null
      ? { count: keep, positions, scales, rotations, colors, sh, shDegree }
      : { count: keep, positions, scales, rotations, colors }
  validateGaussianSplatData(result)
  return result
}
