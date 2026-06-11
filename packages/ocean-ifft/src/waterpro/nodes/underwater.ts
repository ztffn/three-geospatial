// Underwater post effect: per-channel absorption fog + procedural Voronoi
// caustics. Faithful-in-spirit replacement for WaterPro's WASM underwater
// programs (underwaterResult / TIR / particles — see PORT-STATUS "remaining"
// items 2-4); the caustics are a cheap animated-Voronoi fake (F2-F1 edge
// webbing), deliberately NOT real refraction. Scene-agnostic: the caller
// supplies ocean-local pixel position + camera distance nodes (so renderer
// specifics like logarithmic depth stay outside this package).

import {
  dot,
  exp,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { Vector3 } from 'three'
import type { UniformNode } from 'three/webgpu'

// Clear-ocean absorption per metre (red dies first). Scaled by
// `absorptionScale` so one slider sets visibility.
const ABSORPTION = [0.3, 0.08, 0.04] as const

export interface UnderwaterUniforms {
  /** Master switch (leva). 0 disables the whole effect. */
  enabled: UniformNode<number>
  /** 1 when the camera is below the wave surface (driven per frame). */
  underwaterT: UniformNode<number>
  /** Camera depth below the surface in metres (driven per frame). */
  cameraDepthBelow: UniformNode<number>
  /** Multiplier on the per-channel absorption (higher = murkier). */
  absorptionScale: UniformNode<number>
  /** In-scatter colour the fog converges to (linear RGB). */
  waterTint: UniformNode<Vector3>
  /** Fog luminance multiplier — matches scene radiance units via leva. */
  fogIntensity: UniformNode<number>
  /** 1/m — ambient + caustics darkening with depth below the surface. */
  ambientFalloff: UniformNode<number>
  causticsIntensity: UniformNode<number>
  /** Cell size in metres. */
  causticsScale: UniformNode<number>
  causticsSpeed: UniformNode<number>
  causticsSharpness: UniformNode<number>
}

export function createUnderwaterUniforms(): UnderwaterUniforms {
  return {
    enabled: uniform(1),
    underwaterT: uniform(0),
    cameraDepthBelow: uniform(0),
    // Defaults are the user-tuned values from the Karmøy twin scene.
    absorptionScale: uniform(0.1),
    // Linear RGB of #1f4755.
    waterTint: uniform(new Vector3(0.0137, 0.0633, 0.0908)),
    fogIntensity: uniform(0.3),
    ambientFalloff: uniform(0.04),
    causticsIntensity: uniform(0.1),
    causticsScale: uniform(70),
    causticsSpeed: uniform(0.8),
    causticsSharpness: uniform(4.5),
  }
}

const hash22 = (p: any): any =>
  fract(
    sin(
      vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))
    ).mul(43758.5453)
  )

// Animated Voronoi edge factor: F2 - F1 over a 3x3 neighbourhood with
// sine-jittered feature points. Statically unrolled (expression tree, no TSL
// Loop). Returns ~0 on cell borders, growing toward cell interiors.
const voronoiEdge = (p: any, t: any): any => {
  const n = floor(p)
  const f = fract(p)
  let d1: any = float(8)
  let d2: any = float(8)
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const g = vec2(i, j)
      const h = hash22(n.add(g))
      const o = sin(t.add(h.mul(6.2831))).mul(0.5).add(0.5)
      const r = g.add(o).sub(f)
      const d = dot(r, r)
      // Branchless two-minimum tracking; d2 must use the PRE-update d1.
      const nextD2 = min(d2, max(d1, d))
      d1 = min(d1, d)
      d2 = nextD2
    }
  }
  return sqrt(d2).sub(sqrt(d1))
}

// Bright caustic webbing: 1 at cell borders, sharpened toward 0 inside cells.
// max() floor avoids pow(0, y) — undefined on some GPU drivers (NaN on Metal).
const caustic = (p: any, t: any, sharpness: any): any =>
  pow(max(saturate(float(1).sub(voronoiEdge(p, t))), float(1e-4)), sharpness)

export interface UnderwaterPostParams {
  /** Scene colour (vec4) — typically the aerial-perspective output. */
  inputNode: any
  /** Ocean-local position of the pixel's surface point (vec3, metres). */
  oceanPos: any
  /** Camera → pixel surface distance (float, metres). */
  dist: any
  /** Animation clock in seconds (shared with the wave sim). */
  time: any
  u: UnderwaterUniforms
}

/**
 * Apply underwater absorption fog + Voronoi caustics to the scene colour.
 * Insert between aerial perspective and lens flare; returns vec4. When
 * `u.underwaterT` or `u.enabled` is 0 the input passes through unchanged.
 */
export function underwaterPostNode(params: UnderwaterPostParams): any {
  const { inputNode, oceanPos, dist, time, u } = params

  // Per-channel transmittance over the camera→pixel water path.
  const absorption = vec3(...ABSORPTION).mul(u.absorptionScale)
  const transmittance = exp(dist.mul(absorption).negate())

  // Ambient light decays with how deep the CAMERA sits; the fog converges to
  // the tint at that ambient level so deep dives read dark, not glowing.
  const ambient = exp(u.cameraDepthBelow.mul(u.ambientFalloff).negate())
  const fogColor = u.waterTint.mul(ambient).mul(u.fogIntensity)

  // Caustics on submerged geometry only (fade in over the first metres below
  // the surface), dimming with the pixel's own depth and fogging with
  // distance like everything else.
  //
  // pixelDepth MUST be clamped to >= 0 before the exp(): pixels whose
  // reconstructed position is ABOVE the sea plane (sky/horizon at depth≈1
  // reconstructs ~1e8 m away → oceanPos.y hugely positive) give a hugely
  // negative pixelDepth, exp() overflows to Inf, and Inf · submerged(=0) is
  // NaN → black regions sweeping the screen as the camera turns.
  // Fade-in starts BELOW the wave envelope (~±4 m at storm amplitudes) so the
  // water surface itself — whose troughs dip below the y=0 plane — never
  // catches caustics when seen from below; only genuinely submerged geometry
  // (hull bottoms, cables, seabed) does.
  const pixelDepth = oceanPos.y.negate()
  const submerged = smoothstep(float(4), float(8), pixelDepth)
  const causticFade = exp(max(pixelDepth, float(0)).mul(u.ambientFalloff).negate())
  const cuv = oceanPos.xz.div(u.causticsScale)
  const ct = time.mul(u.causticsSpeed)
  const aberration = vec2(0.012, 0.007)
  const layer2 = caustic(cuv.mul(1.83).add(vec2(5.2, 1.3)), ct.mul(1.23), u.causticsSharpness)
  const causticsRGB = vec3(
    caustic(cuv.add(aberration), ct, u.causticsSharpness),
    caustic(cuv, ct, u.causticsSharpness),
    caustic(cuv.sub(aberration), ct, u.causticsSharpness)
  )
    .mul(layer2)
    .mul(submerged)
    .mul(causticFade)
    .mul(u.causticsIntensity)

  const lit = inputNode.rgb.add(causticsRGB)
  const fogged = lit
    .mul(transmittance)
    .add(fogColor.mul(vec3(1, 1, 1).sub(transmittance)))

  // underwaterT is a SMOOTHED 0..1 (driven with hysteresis on the CPU) so the
  // fog eases in instead of strobing at the surface crossing. The outer
  // select fully isolates the above-water image: with plain mix, a NaN in the
  // fogged branch would bleed through (NaN·0 = NaN).
  const amount = saturate(u.underwaterT).mul(u.enabled)
  const blended = mix(inputNode.rgb, fogged, amount)
  return vec4(
    select(amount.greaterThan(float(1e-3)), blended, inputNode.rgb),
    inputNode.a
  )
}
