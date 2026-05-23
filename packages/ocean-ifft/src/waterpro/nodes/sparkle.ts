// WaterPro program 1 (sun glow / sparkle) ported as a TSL node.
// Mirrors decompiled OF.build({viewDir, sunDir, flippedNormal},
// [enabled, focusPower, intensity, colorR, colorG, colorB]).
// Returns a single vec3 glowColor — the angular Phong specular highlight
// of the sun against the wave normal, multiplied by sun color and intensity.
//
// Output of program 1 in the original code is destructured as `.glowColor`
// and added on top of the water color in the same compositing slot as the
// SSS contribution, but driven by reflection alignment instead of forward
// transmission.
//
// Defaults from the decompiled OF class:
//   enabled=1, focusPower=75.7, intensity=5.81, color=(1.0, 0.97, 0.88) — a
//   warm-white sun tint.

import {
  dot,
  pow,
  reflect,
  saturate,
  vec3,
} from 'three/tsl'

export interface SparkleParams {
  /** Unit view direction, fragment → camera. */
  viewDir: any
  /** Unit sun-light propagation direction (sun → scene). */
  sunDir: any
  /** Surface normal flipped to face the camera (vec3, unit). */
  flippedNormal: any
  /** 0|1 master switch. */
  enabled: any
  /** Specular exponent — higher = tighter sun glint. WaterPro default 75.7. */
  focusPower: any
  /** Brightness multiplier. WaterPro default 5.81. */
  intensity: any
  /** Sun color (vec3). WaterPro default (1.0, 0.97, 0.88). */
  color: any
}

export interface SparkleOutputs {
  /** vec3 color contribution to ADD onto the water color, before foam. */
  glowColor: any
}

export function sparkleNode(params: SparkleParams): SparkleOutputs {
  // Reflect the incoming sun direction off the surface. The view sees the
  // reflected light most strongly where `reflected` aligns with `viewDir`.
  const reflected = reflect(params.sunDir, params.flippedNormal)
  const spec = saturate(dot(reflected, params.viewDir))
  const glow = pow(spec, params.focusPower)

  // OF.build returns the single output `glowColor` = color * glow * intensity.
  const enabled = params.enabled
  return {
    glowColor: params.color.mul(glow).mul(params.intensity).mul(enabled),
  }
}
