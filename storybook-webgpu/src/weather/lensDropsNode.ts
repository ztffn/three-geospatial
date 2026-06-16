// lensDropsNode.ts — Detachable screen-space "wet lens" raindrop refraction.
// A fullscreen TSL post node: procedural droplets on the camera lens that refract
// the already-rendered composite (no scene re-render — it offset-samples a
// materialized scene-colour texture). Pure node module, no React/scene deps; a
// sibling of createPrecipitationSystem.ts. Identity passthrough when strength≈0.

import {
  dot,
  float,
  hash,
  length,
  max,
  mix,
  pow,
  screenSize,
  screenUV,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * Default tunables — the SINGLE source of truth. The factory seeds its uniforms
 * from these and the story's leva panel uses them as control defaults, so the
 * layers can't drift apart (same pattern as PRECIP_DEFAULTS in the rain plugin).
 */
export const LENS_DROPS_DEFAULTS = {
  /** Master visibility [0,1]; the story multiplies it by the rain/water/altitude
   *  gates each frame. At 0 the node is a pixel-exact passthrough of the scene. */
  strength: 1,
  /** Per-grid drop spawn probability scale [0,1] — how many cells host a drop. */
  density: 0.8,
  /** Refraction gain: magnification of the scene seen through a drop. */
  refract: 1.2,
  /** Wet-glass base defocus radius, in framebuffer texels. */
  blur: 1.4,
  /** How strongly a drop replaces the wet base with the refracted view [0,1]. */
  dropOpacity: 0.9,
  /** Edge highlight (bright rim) intensity — subtle readability cue. */
  rim: 0.15
}

/** CPU-side values pushed into the node's uniforms each render. */
export interface LensDropsValues {
  strength: number
  density: number
  refract: number
  blur: number
  dropOpacity: number
  rim: number
}

export interface LensDrops {
  uniforms: {
    strength: ReturnType<typeof uniform>
    density: ReturnType<typeof uniform>
    refract: ReturnType<typeof uniform>
    blur: ReturnType<typeof uniform>
    dropOpacity: ReturnType<typeof uniform>
    rim: ReturnType<typeof uniform>
  }
  /** Wrap a MATERIALIZED scene-colour texture node (the composite RTT) into the
   *  refracted output node. Must be a real texture so it can be offset-sampled —
   *  a single-pass node graph can't read its own in-flight result. */
  apply: (sceneColor: Node) => Node
  /** Push CPU values into the uniforms. Call each render. */
  sync: (v: LensDropsValues) => void
  dispose: () => void
}

// Three procedural grids at different scales/seeds. Each cell hosts at most one
// drop, with radius capped < 0.5 cell so drops never cross a cell boundary —
// that removes the need for any neighbour search, and the overlapping layers
// supply size variety and break up the lattice. (cells = grid divisions over the
// vertical screen extent; x is aspect-corrected so cells stay square on screen.)
const LAYERS = [
  { cells: 9, seed: 0.0 },
  { cells: 15, seed: 41.0 },
  { cells: 24, seed: 87.0 }
]

export function createLensDrops(): LensDrops {
  const d = LENS_DROPS_DEFAULTS
  const u = {
    strength: uniform(d.strength),
    density: uniform(d.density),
    refract: uniform(d.refract),
    blur: uniform(d.blur),
    dropOpacity: uniform(d.dropOpacity),
    rim: uniform(d.rim)
  }

  const apply = (sceneColor: Node): Node => {
    const tex = sceneColor as any
    const suv = screenUV as any
    // Aspect (>1 in landscape) squares up the grid cells so drops are round, and
    // a single texel size for the wet-glass blur taps.
    const aspect = (screenSize as any).x.div((screenSize as any).y)
    const texel = vec2(1, 1).div(screenSize as any) as any
    // Aspect-corrected screen coords: x scaled so one grid cell is square.
    const pc = vec2(suv.x.mul(aspect), suv.y) as any

    let cover = float(0) as any // strongest drop coverage at this pixel
    let off = vec2(0, 0) as any // accumulated refraction displacement (uv space)
    let rim = float(0) as any // accumulated edge highlight

    for (const L of LAYERS) {
      const cells = float(L.cells)
      const p = pc.mul(cells)
      const cell = p.floor()
      const f = p.fract().sub(0.5) // cell-local coords in [-0.5, 0.5]
      // Per-cell deterministic randoms — the same seed offsets as the rain plugin.
      const id = cell.x.add(cell.y.mul(113.0)).add(L.seed)
      const r1 = hash(id) as any
      const r2 = hash(id.add(13.17)) as any
      const r3 = hash(id.add(31.41)) as any
      const r4 = hash(id.add(57.93)) as any

      // Present? Spawn probability scales with the density uniform.
      const present = r4.lessThan(u.density.mul(0.35)).select(float(1), float(0))
      // Lifecycle: fade in, hold, fade out over a slow cycle; sink slightly with
      // age so drops drift toward screen-bottom like real lens beading.
      const life = (time as any).mul(0.04).add(r1).fract()
      const fade = smoothstep(float(0), float(0.12), life).mul(
        smoothstep(float(1), float(0.7), life)
      )
      const sink = life.mul(0.22)
      const center = vec2(
        r1.sub(0.5).mul(0.5),
        r2.sub(0.5).mul(0.5).sub(sink)
      ) as any
      const radius = mix(float(0.12), float(0.3), r3) // < 0.5 cell → no clipping
      const dvec = f.sub(center)
      const dist = length(dvec)
      const mask = smoothstep(radius, radius.mul(0.8), dist).mul(fade).mul(present)

      // Fake spherical normal in cell space; nz is high at the centre, →0 at the
      // rim. The outward in-plane component drives the refraction displacement.
      const nxy = dvec.div(radius)
      const nz = max(float(1).sub(dot(nxy, nxy)), float(0)).sqrt()

      // Convert the cell-local offset to uv (undo the cells scale and the aspect
      // on x) and scale by the refraction gain. Sampling the scene shifted toward
      // the drop centre magnifies it — the classic drop-as-lens look.
      const dispUv = vec2(
        dvec.x.div(aspect.mul(cells)),
        dvec.y.div(cells)
      ).mul(u.refract) as any
      off = off.add(dispUv.mul(mask))
      cover = max(cover, mask)
      rim = rim.add(pow(float(1).sub(nz), float(3)).mul(mask))
    }

    // Wet-glass base: a cheap 5-tap blur of the composite (defocus through the
    // water film). Refraction reads the SAME materialized texture, just offset.
    const r = (u.blur as any).mul(texel)
    const baseTap = tex.sample(suv)
    const blurCol = baseTap
      .add(tex.sample(suv.add(vec2(r.x, r.y))))
      .add(tex.sample(suv.add(vec2(r.x.negate(), r.y))))
      .add(tex.sample(suv.add(vec2(r.x, r.y.negate()))))
      .add(tex.sample(suv.add(vec2(r.x.negate(), r.y.negate()))))
      .div(5)

    // Sample the magnified view toward the drop centre, clamped to the frame.
    const refrCol = tex.sample(suv.sub(off).saturate())
    const coverage = (cover as any).saturate().mul(u.dropOpacity)
    const lensRgb = mix(blurCol.rgb, refrCol.rgb, coverage).add(
      (rim as any).mul(u.rim)
    )

    // Master gate → exact passthrough of the untouched composite when strength≈0.
    const gate = (u.strength as any).saturate()
    const outRgb = mix(baseTap.rgb, lensRgb, gate)
    return vec4(outRgb, baseTap.a) as any
  }

  const sync = (v: LensDropsValues): void => {
    u.strength.value = v.strength
    u.density.value = v.density
    u.refract.value = v.refract
    u.blur.value = v.blur
    u.dropOpacity.value = v.dropOpacity
    u.rim.value = v.rim
  }

  // No GPU resources are owned here — the composite RTT is created and owned by
  // the caller (convertToTexture in the story). Kept for contract symmetry.
  const dispose = (): void => {}

  return { uniforms: u, apply, sync, dispose }
}
