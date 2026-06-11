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
  Fn,
  fract,
  If,
  max,
  min,
  mix,
  pow,
  saturate,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { Color, Vector3 } from 'three'
import type { UniformNode } from 'three/webgpu'

// Clear-ocean absorption per metre (red dies first). Scaled by
// `absorptionScale` so one slider sets visibility.
const ABSORPTION = [0.3, 0.08, 0.04] as const

// Single source of truth for the tunable defaults (user-tuned on the Karmøy
// twin scene). Consumers building UI controls (leva) should read their
// default values from here so package and scene cannot drift; the tint is
// kept as an sRGB hex string and converted once below.
export const UNDERWATER_DEFAULTS = {
  absorptionScale: 0.1,
  waterTint: '#1f4755',
  fogIntensity: 0.3,
  ambientFalloff: 0.04,
  causticsIntensity: 0.1,
  causticsScale: 70,
  causticsSpeed: 0.8,
  causticsSharpness: 4.5,
  /** Caustics fade in between these two depths below the surface (metres) —
   * the band starts BELOW the wave envelope so the displaced water surface
   * itself never catches caustics when seen from below. */
  causticsMinDepth: 4,
  causticsFullDepth: 8,
} as const

export interface UnderwaterUniforms {
  /** Master switch (leva). 0 disables the whole effect. */
  enabled: UniformNode<number>
  /** Smoothed 0..1 camera submersion (driven per frame with hysteresis). */
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
  /** Depth below the surface where caustics start fading in (metres). */
  causticsMinDepth: UniformNode<number>
  /** Depth below the surface where caustics are fully visible (metres). */
  causticsFullDepth: UniformNode<number>
}

export function createUnderwaterUniforms(): UnderwaterUniforms {
  const d = UNDERWATER_DEFAULTS
  const tint = new Color(d.waterTint) // sRGB hex → linear
  return {
    enabled: uniform(1),
    underwaterT: uniform(0),
    cameraDepthBelow: uniform(0),
    absorptionScale: uniform(d.absorptionScale),
    waterTint: uniform(new Vector3(tint.r, tint.g, tint.b)),
    fogIntensity: uniform(d.fogIntensity),
    ambientFalloff: uniform(d.ambientFalloff),
    causticsIntensity: uniform(d.causticsIntensity),
    causticsScale: uniform(d.causticsScale),
    causticsSpeed: uniform(d.causticsSpeed),
    causticsSharpness: uniform(d.causticsSharpness),
    causticsMinDepth: uniform(d.causticsMinDepth),
    causticsFullDepth: uniform(d.causticsFullDepth),
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
  pow(max(voronoiEdge(p, t).oneMinus(), float(1e-4)), sharpness)

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

  return Fn(() => {
    const result = vec4(inputNode).toVar()

    // Real branch (If, not select/mix): the condition is uniform-derived, so
    // the whole dispatch takes the same path and the fog + 4 Voronoi
    // evaluations cost nothing while the camera is above water (>99% of the
    // time). WGSL select() would evaluate both operands every pixel — and a
    // NaN in the fogged branch would bleed into the above-water image.
    const amount = saturate(u.underwaterT).mul(u.enabled)
    If(amount.greaterThan(float(1e-3)), () => {
      // Per-channel transmittance over the camera→pixel water path.
      const absorption = vec3(...ABSORPTION).mul(u.absorptionScale)
      const transmittance = exp(dist.mul(absorption).negate())

      // Ambient light decays with how deep the CAMERA sits; the fog converges
      // to the tint at that ambient level so deep dives read dark, not glowing.
      const ambient = exp(u.cameraDepthBelow.mul(u.ambientFalloff).negate())
      const fogColor = u.waterTint.mul(ambient).mul(u.fogIntensity)

      // Caustics on submerged geometry only, dimming with the pixel's own
      // depth and fogging with distance like everything else.
      //
      // pixelDepth MUST be clamped to >= 0 before the exp(): pixels whose
      // reconstructed position is ABOVE the sea plane (sky/horizon at depth≈1
      // reconstructs ~1e8 m away → oceanPos.y hugely positive) give a hugely
      // negative pixelDepth, exp() overflows to Inf, and Inf · submerged(=0)
      // is NaN → black regions sweeping the screen as the camera turns.
      const pixelDepth = oceanPos.y.negate()
      const submerged = smoothstep(
        u.causticsMinDepth,
        u.causticsFullDepth,
        pixelDepth
      )
      const causticFade = exp(
        max(pixelDepth, float(0)).mul(u.ambientFalloff).negate()
      )
      const cuv = oceanPos.xz.div(u.causticsScale)
      const ct = time.mul(u.causticsSpeed)
      const aberration = vec2(0.012, 0.007)
      const layer2 = caustic(
        cuv.mul(1.83).add(vec2(5.2, 1.3)),
        ct.mul(1.23),
        u.causticsSharpness
      )
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
        .add(fogColor.mul(transmittance.oneMinus()))

      // underwaterT is smoothed on the CPU (hysteresis + easing) so the fog
      // fades in rather than cutting at the surface crossing.
      result.assign(vec4(mix(inputNode.rgb, fogged, amount), inputNode.a))
    })

    return result
  })()
}
