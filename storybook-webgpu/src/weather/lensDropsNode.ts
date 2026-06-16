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
  min,
  mix,
  pow,
  screenSize,
  screenUV,
  smoothstep,
  time,
  uniform,
  vec2,
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
  density: 0.42,
  /** Refraction gain: magnification of the scene seen through a drop. */
  refract: 1.2,
  /** Wet-glass base defocus radius, in framebuffer texels. */
  blur: 1.4,
  /** How strongly a drop replaces the wet base with the refracted view [0,1]. */
  dropOpacity: 0.9,
  /** Edge highlight (bright rim) intensity — subtle readability cue. */
  rim: 0.24,
  /** MAX vertical tail elongation reached as a drop ages: a drop starts round
   *  (1) and grows toward this as it fades, so beads elongate into running
   *  streaks. Tails can cross one cell upward (vertical neighbour sampling). */
  streak: 4,
  /** Lifespan scale: >1 makes drops live and linger longer before fading out. */
  linger: 1.5,
  /** Per-drop cycle-rate randomness [0,1]: 0 = one shared rhythm, 1 = widely
   *  staggered so drops appear/disappear at random-looking times. */
  lifeJitter: 0.4
}

/** CPU-side values pushed into the node's uniforms each render. */
export interface LensDropsValues {
  strength: number
  density: number
  refract: number
  blur: number
  dropOpacity: number
  rim: number
  streak: number
  linger: number
  lifeJitter: number
  /** Wet-film blur amount [0,1] — drive from the SURFACING gate only so plain
   *  rain leaves a sharp scene between drops; 1 = full base defocus. */
  wetFilm: number
}

export interface LensDrops {
  uniforms: {
    strength: ReturnType<typeof uniform>
    density: ReturnType<typeof uniform>
    refract: ReturnType<typeof uniform>
    blur: ReturnType<typeof uniform>
    dropOpacity: ReturnType<typeof uniform>
    rim: ReturnType<typeof uniform>
    streak: ReturnType<typeof uniform>
    linger: ReturnType<typeof uniform>
    lifeJitter: ReturnType<typeof uniform>
    wetFilm: ReturnType<typeof uniform>
  }
  /** Wrap a MATERIALIZED scene-colour texture node (the composite RTT) into the
   *  refracted output node. Must be a real texture so it can be offset-sampled —
   *  a single-pass node graph can't read its own in-flight result. */
  apply: (sceneColor: Node) => Node
  /** Push CPU values into the uniforms. Call each render. */
  sync: (v: LensDropsValues) => void
  dispose: () => void
}

// Procedural grids at different scales/seeds. Each cell hosts at most one drop;
// the overlapping layers supply size variety and break up the lattice. (cells =
// grid divisions over the vertical screen extent; x is aspect-corrected so cells
// stay square on screen.) Streak tails run UPWARD past the cell top, so each
// fragment also samples the drop one cell BELOW (whose tail reaches up into it) —
// one extra eval per layer, no wider neighbour search.
//
// The fine grids (9/15/24) are the general wet-lens drops shown in rain. The
// coarse grid is `surfaceOnly`: fewer cells = bigger on-screen drops, gated to the
// SURFACING signal (`wetFilm`) so the large blobs only appear as water sheets off
// the lens on resurfacing — not in plain rain.
const LAYERS = [
  // Resurface blobs: coarse grid (big on screen), radius boosted (rScale) and
  // streak suppressed (streakScale) so they read as fat round beads sheeting off,
  // not thin rivulets. radiusMax·streakMax stays < 1 cell for the neighbour sampler
  // (0.13·1.6 · 7·0.45 ≈ 0.65 cell).
  { cells: 4, seed: 5.0, surfaceOnly: true, rScale: 1.6, streakScale: 0.45 },
  { cells: 9, seed: 0.0, surfaceOnly: false, rScale: 1, streakScale: 1 },
  { cells: 15, seed: 41.0, surfaceOnly: false, rScale: 1, streakScale: 1 },
  { cells: 24, seed: 87.0, surfaceOnly: false, rScale: 1, streakScale: 1 }
]

export function createLensDrops(): LensDrops {
  const d = LENS_DROPS_DEFAULTS
  const u = {
    strength: uniform(d.strength),
    density: uniform(d.density),
    refract: uniform(d.refract),
    blur: uniform(d.blur),
    dropOpacity: uniform(d.dropOpacity),
    rim: uniform(d.rim),
    streak: uniform(d.streak),
    linger: uniform(d.linger),
    lifeJitter: uniform(d.lifeJitter),
    wetFilm: uniform(1)
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

      // Evaluate the drop owned by the cell at (cell.x, cell.y + oy) for this
      // fragment. oy = 0 is the fragment's own cell; oy = -1 is the cell below,
      // whose upward streak tail can reach up into this fragment. Returns the
      // coverage mask, the uv refraction displacement, and the fake-normal nz.
      const evalDrop = (oy: number): { mask: any; dispUv: any; nz: any } => {
        const cy = cell.y.add(float(oy))
        // Stable per-cell randoms drive only the lifecycle TIMING (phase + rate) so
        // the cadence is steady. The APPEARANCE randoms (position/size/present) are
        // re-rolled each cycle from the cycle index, so a faded-out drop is replaced
        // by a NEW one at a new spot — not the same drop pulsing in place. The
        // re-roll lands while the drop is invisible (fade is 0 at the cycle wrap),
        // so it's seamless.
        const id = cell.x.add(cy.mul(113.0)).add(L.seed)
        const phase = hash(id) as any
        const rJit = hash(id.add(73.1)) as any

        // Per-drop cycle rate: a base rate eased by `linger` (longer life) and
        // randomized per drop by `lifeJitter` so drops fall out of sync and vanish
        // at staggered times rather than on one shared rhythm.
        const rate = float(0.04)
          .div(u.linger)
          .mul(
            mix(
              float(1).sub((u.lifeJitter as any).mul(0.6)),
              float(1).add((u.lifeJitter as any).mul(0.6)),
              rJit
            )
          )
        const t = (time as any).mul(rate).add(phase)
        const life = t.fract()
        // Re-roll position/size/presence per cycle (the cycle index seeds them), so
        // each cycle is a fresh drop somewhere new rather than the same one pulsing.
        const cid = id.add(t.floor().mul(101.7))
        const a1 = hash(cid) as any
        const a2 = hash(cid.add(13.17)) as any
        const a3 = hash(cid.add(31.41)) as any
        const a4 = hash(cid.add(57.93)) as any

        // Present? Spawn probability scales with the density uniform; re-rolled each
        // cycle so a cell hosts a drop some cycles and not others.
        const present = a4.lessThan(u.density.mul(0.35)).select(float(1), float(0))
        // Linger: visible for most of the cycle, fading out only in the last ~12%.
        const fade = smoothstep(float(0), float(0.1), life).mul(
          smoothstep(float(1), float(0.88), life)
        )
        const sink = life.mul(0.3)
        // Fragment position in THIS cell's local frame (shift by the row offset).
        const fl = vec2(f.x, f.y.sub(float(oy))) as any
        const center = vec2(
          a1.sub(0.5).mul(0.5),
          a2.sub(0.5).mul(0.5).sub(sink)
        ) as any
        const radius = mix(float(0.07), float(0.13), a3).mul(L.rScale) // head; tail = radius·streak
        const dvec = fl.sub(center)
        // Streak grows from round (1) toward the max as the drop ages — a bead
        // that elongates into a running streak as it fades. The tail is the part
        // ABOVE the head (dvec.y > 0, where the drop fell from), compressed by the
        // current streak so the shape stretches upward.
        const effStreak = mix(float(1), u.streak.mul(L.streakScale), life)
        const tail = max(dvec.y, float(0)).div(effStreak)
        const headSide = min(dvec.y, float(0))
        const shaped = vec2(dvec.x, tail.add(headSide)) as any
        const dist = length(shaped)
        const mask = smoothstep(radius, radius.mul(0.8), dist).mul(fade).mul(present)

        // Fake spherical normal in (shaped) cell space; nz high at the centre,
        // →0 at the rim. The in-plane component drives the refraction so the tail
        // refracts mostly sideways like a cylindrical rivulet lens.
        const nxy = shaped.div(radius)
        const nz = max(float(1).sub(dot(nxy, nxy)), float(0)).sqrt()
        // Convert the cell-local offset to uv (undo the cells scale and aspect on
        // x) and scale by the refraction gain — sampling shifted toward the drop
        // centre magnifies the scene, the classic drop-as-lens look.
        const dispUv = vec2(
          shaped.x.div(aspect.mul(cells)),
          shaped.y.div(cells)
        ).mul(u.refract) as any
        return { mask, dispUv, nz }
      }

      // surfaceOnly layers (the large blobs) are gated to the surfacing wetness so
      // they show only on resurfacing, not in rain; fine layers are ungated.
      const layerGate = L.surfaceOnly ? (u.wetFilm as any).saturate() : float(1)
      // Own cell + the cell below (its tail can hang up into this fragment). Drops
      // are sparse, so the two rarely overlap; max() picks the covering one.
      for (const dd of [evalDrop(0), evalDrop(-1)]) {
        const m = dd.mask.mul(layerGate)
        off = off.add(dd.dispUv.mul(m))
        cover = max(cover, m)
        rim = rim.add(pow(float(1).sub(dd.nz), float(3)).mul(m))
      }
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
    const coverage = cover.saturate().mul(u.dropOpacity)
    // The wet-glass base defocus reads as a continuous water FILM on the lens, so
    // it's gated by `wetFilm` (the surfacing component only): on resurfacing the
    // whole frame softens, but plain RAIN keeps a sharp scene between drops — the
    // individual drops still refract the sharp composite either way.
    const baseCol = mix(baseTap.rgb, blurCol.rgb, (u.wetFilm as any).saturate())
    // Outline is boosted on resurfacing (×wetFilm) so the sheeting blobs read with
    // a stronger rim than the subtler rain drops.
    const rimAmt = (u.rim as any).mul(
      float(1).add((u.wetFilm as any).saturate().mul(1.8))
    )
    const lensRgb = mix(baseCol, refrCol.rgb, coverage).add(rim.mul(rimAmt))

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
    u.streak.value = v.streak
    u.linger.value = v.linger
    u.lifeJitter.value = v.lifeJitter
    u.wetFilm.value = v.wetFilm
  }

  // No GPU resources are owned here — the composite RTT is created and owned by
  // the caller (convertToTexture in the story). Kept for contract symmetry.
  const dispose = (): void => {}

  return { uniforms: u, apply, sync, dispose }
}
