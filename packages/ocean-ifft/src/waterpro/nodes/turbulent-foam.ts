// WaterPro program 11 (turbulent foam) ported as a TSL node.
// Mirrors decompiled TF.build() — samples the wave normal at 4 neighbor
// world-XZ positions, computes the (negative) divergence of the horizontal
// normal components, clamps to a positive value, and returns it as a vec3
// brightness. Where waves converge (normals tilt inward) the divergence is
// negative, so −∇·N is positive → foam appears at that front.
//
// Reference (decompiled fallback path, no normal buffer):
//   r = abs(positionWorld.y)
//   n = 1 + r · depthAttenuation · 0.02     — sampling step grows with depth
//   a = sampleEpsilon · n
//   o = sampleNormal(x+a, z)
//   l = sampleNormal(x-a, z)
//   h = sampleNormal(x,   z+a)
//   u = sampleNormal(x,   z-a)
//   d = (o.x − l.x) / (2a)                 — ∂Nx/∂x
//   p = (h.z − u.z) / (2a)                 — ∂Nz/∂z
//   m = −(d + p)                           — negative divergence
//   g = max(m · intensity · 4, 0)
//   f = clamp(g, 0, 3)
//   return vec3(f, f, f)
//
// Defaults from the decompiled TF class:
//   depthAttenuation = 0.5
//   enabled = 1
//   intensity = 1
//   sampleEpsilon = 2
//   waterSize = 400         (unused in the fallback path; reserved for the
//                            normal-buffer path which is not ported here)

import {
  abs,
  clamp,
  float,
  max,
  positionWorld,
  vec2,
  vec3,
} from 'three/tsl'

/**
 * Sampler callback: given a world-XZ position (vec2), return the wave normal
 * at that point as a vec3 unit vector. Wired by the caller — typically
 * `(xz) => sampleWaveNormal(waveSim, { worldXZ: xz }).normal`.
 */
export type WaveNormalSampler = (worldXZ: any) => any

export interface TurbulentFoamParams {
  /** Wave-normal sampler in world space. */
  sampleNormal: WaveNormalSampler
  /** 0|1 on/off. */
  enabled: any
  /** Step size for the finite-difference normal samples (world meters). */
  sampleEpsilon: any
  /** Scales the step by 1 + |y|·attenuation·0.02; deeper points sample wider. */
  depthAttenuation: any
  /** Overall brightness multiplier. */
  intensity: any
  /** Optional world-XZ override (vec2) for the centre sample. */
  worldXZ?: any
}

export interface TurbulentFoamOutputs {
  /** vec3 (uniform RGB) brightness contribution at convergence fronts. */
  foam: any
}

export function turbulentFoamNode(
  params: TurbulentFoamParams
): TurbulentFoamOutputs {
  const centerXZ = params.worldXZ ?? vec2(positionWorld.x, positionWorld.z)

  // Depth-attenuated step.
  const depthFactor = float(1).add(
    abs(positionWorld.y).mul(params.depthAttenuation).mul(float(0.02))
  )
  const a = params.sampleEpsilon.mul(depthFactor)

  // 4 neighbour samples along ±x and ±z.
  const nXPlus = params.sampleNormal(vec2(centerXZ.x.add(a), centerXZ.y))
  const nXMinus = params.sampleNormal(vec2(centerXZ.x.sub(a), centerXZ.y))
  const nZPlus = params.sampleNormal(vec2(centerXZ.x, centerXZ.y.add(a)))
  const nZMinus = params.sampleNormal(vec2(centerXZ.x, centerXZ.y.sub(a)))

  const step = a.mul(float(2))
  const dNx_dx = nXPlus.x.sub(nXMinus.x).div(step)
  const dNz_dz = nZPlus.z.sub(nZMinus.z).div(step)

  // −∇·N — positive where waves converge.
  const m = dNx_dx.add(dNz_dz).negate()
  const scaled = max(m.mul(params.intensity).mul(float(4)), float(0))
  const clamped = clamp(scaled, float(0), float(3)).mul(params.enabled)

  return { foam: vec3(clamped, clamped, clamped) }
}
