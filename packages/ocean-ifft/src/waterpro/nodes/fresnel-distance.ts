// WaterPro program 2 (fresnel + distance fade) ported as a TSL node.
// Mirrors decompiled MF.build({viewDir, interpolatedNormal, worldX, worldZ},
// [fadeStart, fadeEnd, fadePower, normalStrength, power]). Returns the six
// outputs the WASM program exposes:
//   fresnel          : 0..1 Schlick-style fresnel using a normal-strength
//                       dampened normal (`fresnelNormal`)
//   fresnelNormal    : normalize(mix(flat-up, interpolatedNormal, normalStrength))
//                       — keeps reflection direction stable when normalStrength
//                       is low, prevents wave-detail noise from feeding fresnel
//   distanceToCamera : length(cameraPos − fragmentPos) in world meters
//   distanceFade     : smoothstep(fadeStart, fadeEnd, distanceToCamera)^fadePower
//                       — used by callers to fade ocean toward sky color at
//                       the horizon
//   fadeStart/fadeEnd: pass-through of the input uniforms so downstream code
//                       can rebuild custom fades without re-uploading them
//
// WaterPro defaults (from MF class field initializers):
//   fadeStart=50, fadeEnd=200, fadePower=1, normalStrength=0.1, power=3

import {
  float,
  vec3,
  pow,
  smoothstep,
  saturate,
  mix,
  normalize,
  dot,
  cameraPosition,
  positionWorld,
  length,
} from 'three/tsl'

export interface FresnelDistanceParams {
  /** Unit view direction (fragment → camera). Defaults to TSL-derived. */
  viewDir?: any
  /** Surface normal at the fragment (vec3, unit length). */
  interpolatedNormal: any
  /** Optional world-XZ override (e.g. when host has a custom positionNode). */
  worldX?: any
  worldZ?: any
  /** Distance fade start (world meters). */
  fadeStart: any
  /** Distance fade end (world meters). */
  fadeEnd: any
  /** Distance fade curve power. */
  fadePower: any
  /** 0..1 — how much wave-detail normal feeds into fresnel. 0=flat, 1=full. */
  normalStrength: any
  /** Fresnel exponent (Schlick-like). WaterPro default 3. */
  power: any
  /**
   * Optional override for the "flat" reference normal (world frame). Defaults
   * to world-Y (0,1,0). For surfaces tangent to a globe (ECEF chunks at a
   * specific lat/lon), pass the geocentric up direction at the ocean centre
   * — otherwise the normal-strength mix drags the fresnel normal toward
   * Earth's spin axis, not local up, and creates visible angle artefacts.
   */
  flatNormal?: any
}

export interface FresnelDistanceOutputs {
  fresnel: any
  fresnelNormal: any
  distanceToCamera: any
  distanceFade: any
  fadeStart: any
  fadeEnd: any
}

export function fresnelDistanceNode(
  params: FresnelDistanceParams
): FresnelDistanceOutputs {
  // World-space fragment position. If caller provided worldX/Z overrides
  // (e.g. derived from a custom positionNode + modelWorldMatrix), respect
  // them; otherwise fall back to TSL's built-in.
  const wx = params.worldX ?? positionWorld.x
  const wz = params.worldZ ?? positionWorld.z
  const worldY = positionWorld.y
  const worldPos = vec3(wx, worldY, wz)

  const viewVec = cameraPosition.sub(worldPos)
  const distanceToCamera = length(viewVec)
  const viewDir = params.viewDir ?? normalize(viewVec)

  // Dampened normal feeding the fresnel computation. The "flat" reference
  // is local-up by default (world Y for a plane-at-origin scene). Callers
  // whose surface lives in a rotated world frame — e.g. an ocean tangent to
  // an ECEF sphere — must override with the actual surface-up direction or
  // the mix produces a normal pointing the wrong way (visible as a hard
  // diagonal seam where viewDir·fresnelNormal crosses sign).
  const flatNormal = params.flatNormal ?? vec3(float(0), float(1), float(0))
  const fresnelNormal = normalize(
    mix(flatNormal, params.interpolatedNormal, params.normalStrength)
  )

  // Schlick fresnel with water F0 baked in (matches the WaterPro WASM
  // program 2 output magnitude — without F0 the reflection mix dominates
  // appearance everywhere except straight-down nadir).
  //   F0 = 0.02  // air ↔ water reflectance at normal incidence
  //   F  = F0 + (1 − F0) · (1 − cosθ)^power
  // At 45° viewing this gives F ≈ 0.022 (mostly water color); at 80° ≈ 0.4;
  // at full grazing ≈ 1.
  const F0 = float(0.02)
  const cosTheta = saturate(dot(viewDir, fresnelNormal))
  const grazing = pow(float(1).sub(cosTheta), params.power)
  const fresnel = F0.add(float(1).sub(F0).mul(grazing))

  // Distance fade curve.
  const ramp = smoothstep(params.fadeStart, params.fadeEnd, distanceToCamera)
  const distanceFade = pow(ramp, params.fadePower)

  return {
    fresnel,
    fresnelNormal,
    distanceToCamera,
    distanceFade,
    fadeStart: params.fadeStart,
    fadeEnd: params.fadeEnd,
  }
}
