// TSL sampler for the WaveSimulation output.
// Matches the WaterPro decompiled SF.sampleDisplacement / SF.sampleNormals
// surface: takes world-space (x, z) and returns the displaced position +
// surface normal + Jacobian eigenvalues used by program 7 (wave foam).
//
// Per-cascade convention: UV = worldXZ / lengthScale (RepeatWrapping tiles
// the cascade everywhere). Cascades are summed (Tessendorf-style cascading).
// Output:
//   displacement (vec3) : sum of (Dx, Dy, Dz) across cascades
//   normal       (vec3) : sum of ∂y/∂x and ∂y/∂z derivatives → reconstructed
//                         unit normal in TBN-y-up basis
//   eigen0/eigen1 (f32) : Jacobian eigenvalues from cascade 0; rough proxy
//                         for wave-steepness / breaking-crest mask used by
//                         the wave-foam node

import { texture as tslTexture, float, vec2, vec3, normalize } from 'three/tsl'
import type { WaveSimulation } from './wave-simulation.js'

export interface SampleOpts {
  /** World-space XZ position to sample at. Use TSL `positionWorld.xz`-style. */
  worldXZ: any
}

export interface DisplacementSample {
  displacement: any  // vec3 (Dx, Dy, Dz) summed across cascades
}

export interface NormalSample {
  normal: any   // vec3 unit normal
  eigen0: any   // f32 Jacobian eigenvalue (cascade 0)
  eigen1: any   // f32 Jacobian eigenvalue (cascade 0)
}

/**
 * Sum displacement across all cascades for the given world-XZ position.
 * Each cascade contributes Dx, Dy, Dz scaled by its own length-scale UV.
 */
export function sampleWaveDisplacement(
  sim: WaveSimulation,
  opts: SampleOpts
): DisplacementSample {
  let dx: any = float(0)
  let dy: any = float(0)
  let dz: any = float(0)
  for (const cascade of sim.cascades) {
    const uv = opts.worldXZ.div(float(cascade.lengthScale))
    const sample = tslTexture(cascade.displacement, uv)
    dx = dx.add(sample.x)
    dy = dy.add(sample.y)
    dz = dz.add(sample.z)
  }
  return { displacement: vec3(dx, dy, dz) }
}

/**
 * Combine derivative textures across cascades into a surface normal.
 * Mirrors the decompiled SF.sampleNormals math: per-cascade derivative texels
 * carry (∂y/∂x, ∂y/∂z, ?, eigenvalue); sum the slope vector then normalize.
 * Eigenvalues come from cascade 0 (the smallest-scale cascade is dominant for
 * crest-foam detection per WaterPro's eigenvalue→foam mapping).
 */
export function sampleWaveNormal(
  sim: WaveSimulation,
  opts: SampleOpts
): NormalSample {
  let slopeX: any = float(0)
  let slopeZ: any = float(0)
  let eigen0: any = float(0)
  let eigen1: any = float(0)
  sim.cascades.forEach((cascade, i) => {
    const uv = opts.worldXZ.div(float(cascade.lengthScale))
    const sample = tslTexture(cascade.derivative, uv)
    slopeX = slopeX.add(sample.x)
    slopeZ = slopeZ.add(sample.y)
    if (i === 0) {
      // The cascade's jacobian render target stores the TURBULENCE value
      // (Tessendorf J = (1+λDxx)(1+λDzz)−λ²Dxz²), which is ≈1 on flat water
      // and drops toward 0/negative at folding wave crests. WaterPro's
      // program 7 expects an `eigen` input that is HIGH at crests, so invert:
      //   crestIndicator = 1 − turbulence
      //   → 0 on calm water, positive (up to ~1+) where waves break
      const turbulence = tslTexture(cascade.jacobian, uv).x
      eigen0 = float(1).sub(turbulence)
      // We don't have a second channel; the existing IFFT pipeline writes
      // only R. Leave eigen1 at 0 — `max(eigen0, eigen1)` in wave-foam picks
      // up eigen0 unmodified.
      eigen1 = float(0)
    }
  })
  // Reconstruct normal from slope vector in y-up basis.
  const normal = normalize(vec3(slopeX.negate(), float(1), slopeZ.negate()))
  return { normal, eigen0, eigen1 }
}

/**
 * Convenience helper: compute everything the wave-foam node needs at a given
 * world-XZ position. Use this in fragment shaders.
 */
export function sampleWaveSurface(
  sim: WaveSimulation,
  worldXZ: any
): DisplacementSample & NormalSample {
  const d = sampleWaveDisplacement(sim, { worldXZ })
  const n = sampleWaveNormal(sim, { worldXZ })
  return { ...d, ...n }
}
