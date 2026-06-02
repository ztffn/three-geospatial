// WaterPro program 7 (waveFoam / turbulentFoam) ported as a TSL node.
// Mirrors decompiled PF.build({worldX, worldZ, eigen0, eigen1, windDirection,
// surfaceNormal, hasJacobianFoam}, [enabled, waveWeight, rippleWeight,
// crestCoverage, windBias, size, windStretch, texture, coverage, opacity,
// peakIntensity, color]). Returns {strength, color}.
//
// The WASM program math isn't extractable. This is a best-effort port that
// composites three contributions the WaterPro UI exposes:
//   1. Jacobian crest foam — `step(crestCoverage, max(eigen0, eigen1))` gated
//      by hasJacobianFoam; scaled by peakIntensity.
//   2. Wave-stretched noise — tiled noise sampled with UV anisotropy along
//      windDirection (compressed by `windStretch` along the wind axis).
//   3. Ripple noise — same texture, 4x frequency, isotropic, weighted by
//      rippleWeight.
// `waveWeight` and `windBias` blend the wave + ripple contributions and bias
// toward the wind-aligned axis, respectively.

import {
  texture as tslTexture,
  float,
  vec2,
  vec3,
  smoothstep,
  max,
  positionWorld,
  dot,
} from 'three/tsl'
import type { Texture } from 'three'

export interface WaveFoamParams {
  foamTexture: Texture
  enabled?: any         // 0|1; default 1
  waveWeight: any       // weight on wind-stretched noise
  rippleWeight: any     // weight on isotropic high-freq noise
  crestCoverage: any    // threshold on max(eigen0, eigen1) for crest foam
  windBias: any         // 0..1, blends combined toward wind-aligned only
  size: any             // foam tile size (m); UV = worldXZ / size
  windStretch: any      // anisotropy factor along wind direction
  coverage: any         // 0..1 threshold on the combined noise
  opacity: any          // 0..1 multiplier on the masked output
  peakIntensity: any    // scale on Jacobian crest contribution
  foamColor: any        // vec3 tint
  // Per-fragment inputs the original program 7 consumes:
  eigen0?: any          // Jacobian eigenvalue 0 (default 0 → no crest foam)
  eigen1?: any          // Jacobian eigenvalue 1 (default 0)
  windDirection?: any   // vec2 (default (1,0))
  surfaceNormal?: any   // vec3 (default (0,1,0); reserved for future use)
  hasJacobianFoam?: any // 0|1 (default 0 → ignore eigenvalues)
  oceanPositionWorld?: any
}

export interface WaveFoamOutputs {
  strength: any
  color: any
}

export function waveFoamNode(params: WaveFoamParams): WaveFoamOutputs {
  const enabled = params.enabled ?? float(1)
  const eigen0 = params.eigen0 ?? float(0)
  const eigen1 = params.eigen1 ?? float(0)
  const hasJacobianFoam = params.hasJacobianFoam ?? float(0)
  const windDir = params.windDirection ?? vec2(float(1), float(0))
  const posWorld = params.oceanPositionWorld ?? positionWorld

  // 1) Crest mask — soft threshold on Jacobian eigenvalue.
  // This is what *gates* the foam to actual wave-breaking locations.
  // smoothstep over a 0.2-eigenvalue band keeps the transition soft.
  const maxEigen = max(eigen0, eigen1)
  const crestMask = smoothstep(
    params.crestCoverage,
    params.crestCoverage.add(float(0.2)),
    maxEigen,
  ).mul(hasJacobianFoam)

  // 2) Noise detail — texture variation INSIDE the crest band, not used to
  // gate where foam appears. Wave-stretched (anisotropic along wind axis) +
  // ripple (4× freq, isotropic) blended by windBias.
  const windPerp = vec2(windDir.y.negate(), windDir.x)
  const posXZ = vec2(posWorld.x, posWorld.z)
  const along = dot(posXZ, windDir).div(params.size.mul(params.windStretch))
  const across = dot(posXZ, windPerp).div(params.size)
  const waveNoise = tslTexture(params.foamTexture, vec2(along, across)).r.mul(params.waveWeight)
  const rippleNoise = tslTexture(
    params.foamTexture,
    posXZ.div(params.size).mul(float(4)),
  ).r.mul(params.rippleWeight)
  const combined = waveNoise.add(rippleNoise).mul(float(0.5))
  const biasedNoise = combined.add(waveNoise.sub(combined).mul(params.windBias))
  // `coverage` defines how much of the noise becomes foam *within* the crest.
  // Lower coverage = sparser texture, higher = more solid white at crests.
  const detail = smoothstep(float(1).sub(params.coverage), float(1), biasedNoise)

  // 3) Final: foam appears only where crests fire, with noise texture inside.
  const strength = crestMask
    .mul(detail)
    .mul(params.peakIntensity)
    .mul(params.opacity)
    .mul(enabled)

  return { strength, color: params.foamColor }
}
