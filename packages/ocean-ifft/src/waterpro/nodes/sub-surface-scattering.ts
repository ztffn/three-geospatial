// WaterPro program 3 (subsurface scattering / SSS) ported as a TSL node.
// Mirrors decompiled NF.build({viewDir, sunDir, waveNormal, waterColor,
// distanceToCamera, transmissionColor, sunIntensity, fadeStart, fadeEnd},
// [enabled, power, intensity]). The WASM math is opaque but the input list
// is unambiguous — this is back-scatter of sun light through wave crests
// toward the camera, plus a near-distance falloff and water-color tinting.
//
// Returned value is a vec3 to ADD onto the base water color before reflection
// blending and foam, matching the WaterPro fragment compositing order.
//
// Physical model:
//   • Forward scatter lobe = (viewDir · −sunDir)^power
//     — bright when the camera looks toward the sun
//   • Crest-up gate = saturate(waveNormal.y)
//     — only the crest tops let light through, not the steep faces
//   • Distance falloff = 1 − smoothstep(fadeStart, fadeEnd, distanceToCamera)
//     — SSS is a near-field effect, fades to nothing at the horizon
//   • Color = mix(transmissionColor, waterColor, 0.3) — sun light tinted by
//     the water it just passed through

import {
  dot,
  float,
  mix,
  pow,
  saturate,
  smoothstep,
} from 'three/tsl'

export interface SubSurfaceScatteringParams {
  /** View direction, fragment → camera, unit length. */
  viewDir: any
  /** Sun direction (light propagation direction; from sun toward scene). */
  sunDir: any
  /** Surface normal (including IFFT + Gerstner contributions). */
  waveNormal: any
  /** Base water color (deep/shallow lerp from program 4). */
  waterColor: any
  /** Distance from camera to fragment (from program 2). */
  distanceToCamera: any
  /** SSS tint — typically pale cyan (WaterPro default 0x00ffcc). */
  transmissionColor: any
  /** Sun brightness multiplier. */
  sunIntensity: any
  /** Fade start (m) — typically shared with program 2. */
  fadeStart: any
  /** Fade end (m) — typically shared with program 2. */
  fadeEnd: any
  /** 0|1 on/off. */
  enabled: any
  /** Lobe sharpness — WaterPro NF default 4. Higher = tighter glare zone. */
  power: any
  /** Overall SSS scale — WaterPro NF default 1. */
  intensity: any
}

export interface SubSurfaceScatteringOutputs {
  /** Vec3 color contribution to add to the base water color. */
  scattering: any
}

export function subSurfaceScatteringNode(
  params: SubSurfaceScatteringParams
): SubSurfaceScatteringOutputs {
  const backDot = saturate(dot(params.viewDir, params.sunDir.negate()))
  const lobe = pow(backDot, params.power)

  // Active only on wave crests facing roughly up — steep faces don't read as
  // translucent crests, they're full-thickness water.
  const upTerm = saturate(params.waveNormal.y)

  // Near-field only.
  const distFade = float(1).sub(
    smoothstep(params.fadeStart, params.fadeEnd, params.distanceToCamera)
  )

  // Sun light tinted by the surrounding water it just passed through.
  const tint = mix(params.transmissionColor, params.waterColor, float(0.3))

  const strength = lobe
    .mul(upTerm)
    .mul(distFade)
    .mul(params.intensity)
    .mul(params.sunIntensity)
    .mul(params.enabled)

  return { scattering: tint.mul(strength) }
}
