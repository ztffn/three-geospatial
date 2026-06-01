// cloud-coverage.ts — Shared analytic cloud-coverage field for the globe scene.
// Owns the ONE coverage model (procedural FBM-by-direction or live equirect-by-
// lon/lat) plus a ray↔shell intersection, so the cloud shell, the ocean's cloud
// reflection, and the ocean's cloud shadow all sample identical cloud cover from
// a single uniform bag. No probe, no extra passes — a ray-sphere + one coverage
// eval per fragment per effect. Built once per source by the globe story.

import {
  Color,
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  TextureLoader,
  Vector3,
} from 'three'
import type { Texture } from 'three'
import {
  asin,
  atan,
  dot,
  float,
  max,
  mx_fractal_noise_float,
  normalize,
  smoothstep,
  sqrt,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'

import { Ellipsoid } from '@takram/three-geospatial'

const LIVE_CLOUDS_URL =
  'https://clouds.matteason.co.uk/images/2048x1024/clouds-alpha.png'

export type CloudSource = 'procedural' | 'live'

/** CPU-side values pushed into the field uniforms each render. */
export interface CloudFieldValues {
  altitude: number
  opacity: number
  coverage: number
  windSpeed: number
  tiles: number
  dayColor: string
  nightAmbient: number
  density: number
  intensity: number
  contrast: number
  reflectionStrength: number
  shadowStrength: number
  /** DEBUG: 0=off, else paint a reflection term on the ocean (see `debug`). */
  debugMode: number
}

export interface CloudFieldUniforms {
  /** Shell radius in metres (WGS84 max radius + altitude) — drives ray↔shell. */
  radius: UniformNode<number>
  opacity: UniformNode<number>
  coverage: UniformNode<number>
  windSpeed: UniformNode<number>
  tiles: UniformNode<number>
  dayColor: UniformNode<Color>
  nightAmbient: UniformNode<number>
  density: UniformNode<number>
  intensity: UniformNode<number>
  contrast: UniformNode<number>
  reflectionStrength: UniformNode<number>
  shadowStrength: UniformNode<number>
  debugMode: UniformNode<number>
}

export interface CloudField {
  uniforms: CloudFieldUniforms
  /** Live equirect texture, or null in procedural mode. */
  cloudTex: Texture | null
  /**
   * Sample cloud cover along a normalized world DIRECTION. Returns
   * vec4(litAlbedoRGB, edgedCoverage): rgb is the day/night-shaded cloud albedo
   * WITHOUT the shell's emissive `intensity` punch (so reflections stay AgX-
   * safe); a is the edged coverage in [0,1] used for opacity / blend / shadow.
   * One coverage eval per call.
   */
  sampleCloud: (dir: Node) => Node
  /**
   * Normalized direction of the point where a ray (origin, dir) hits the cloud
   * shell sphere centred at the ECEF origin. Surface points are inside the
   * shell, so the positive root always exists.
   */
  rayShellDir: (origin: Node, dir: Node) => Node
  /**
   * Cloud reflection closure for buildWaterproOceanMaterial: intersect the
   * reflection ray with the shell, sample cloud, return albedo + blend factor
   * (edged coverage × reflectionStrength).
   */
  reflect: (reflectDir: Node, originWorld: Node) => { color: Node; blend: Node }
  /**
   * Cloud shadow closure for buildWaterproOceanMaterial: intersect the sun ray
   * with the shell, sample cloud, return a [0,1] sun factor (1 = full sun).
   * Returns constant 1 when no sun direction was supplied.
   */
  shadow: (originWorld: Node) => Node
  /**
   * DEBUG: returns { color, active } for the reflection ray. When debugMode>0,
   * `active` is true and `color` paints the selected term onto the ocean so the
   * artefact's source can be SEEN instead of guessed. Modes: 1=gate, 2=horizon,
   * 3=edged coverage, 4=ray↔shell hit dir (RGB), 5=scrubbed reflectDir (RGB).
   */
  debug: (reflectDir: Node, originWorld: Node) => { color: Node; active: Node }
  /** Push CPU leva values into the uniforms. Call each render. */
  sync: (v: CloudFieldValues) => void
  dispose: () => void
}

/**
 * Build a cloud field for the given source. `sunDirection` is the atmosphere's
 * TO-sun ECEF uniform; when present it drives day/night + terminator shading,
 * identical to the standalone CloudLayer shell.
 */
export function createCloudField(opts: {
  source: CloudSource
  sunDirection?: UniformNode<Vector3>
}): CloudField {
  const { source, sunDirection } = opts

  const uniforms: CloudFieldUniforms = {
    radius: uniform(Ellipsoid.WGS84.maximumRadius + 4000),
    opacity: uniform(0.85),
    coverage: uniform(0.5),
    windSpeed: uniform(0.004),
    tiles: uniform(10),
    dayColor: uniform(new Color('#ffffff')),
    nightAmbient: uniform(0.03),
    density: uniform(0.1),
    intensity: uniform(2.5),
    contrast: uniform(1),
    reflectionStrength: uniform(0.5),
    shadowStrength: uniform(0.6),
    debugMode: uniform(0),
  }

  let cloudTex: Texture | null = null
  if (source === 'live') {
    const t = new TextureLoader().load(LIVE_CLOUDS_URL)
    t.wrapS = RepeatWrapping
    t.colorSpace = NoColorSpace
    t.flipY = false // image top row at v=0 (north), matches the v below
    // No mipmaps. With auto-mip selection, the equirect UV's screen-space
    // derivative spikes at the antimeridian (lon wraps +π→−π, u jumps ~1→0), so
    // the sampler picks the coarsest mip along that one meridian → a thin,
    // view-dependent, sun-independent seam line on the reflection. Bilinear-only
    // (wrapS=Repeat handles the wrap) is seamless for a global map.
    t.minFilter = LinearFilter
    t.magFilter = LinearFilter
    t.generateMipmaps = false
    cloudTex = t
  }

  const u = uniforms

  // Raw cloud cover [0,1] along a world direction — the expensive eval. Mirrors
  // CloudLayer's two source paths exactly so the shell and the ocean agree.
  const rawCoverage = (dir: Node): Node => {
    if (source === 'live' && cloudTex != null) {
      // Equirectangular UV from ECEF lon/lat. +X→(0°N,0°E), +Y→(0°N,90°E),
      // +Z→north pole. flipY=false ⇒ north at v=0.
      const lon = atan((dir as any).y, (dir as any).x)
      // Clamp before asin: a unit dir can round to z = ±1.0000001, and asin of
      // |x|>1 is NaN — a NaN cloud sample survives `·strength` (NaN·0 = NaN) and
      // would draw a fixed line along the wrap meridian.
      const lat = asin((dir as any).z.clamp(float(-1), float(1)))
      const equiUV = vec2(
        (lon as any).div(Math.PI * 2).add(0.5),
        float(0.5).sub((lat as any).div(Math.PI))
      )
      return (texture(cloudTex, equiUV) as any).a.saturate()
    }
    // FBM by world direction — uniform cloud scale, no pole distortion.
    const p = (dir as any)
      .mul(u.tiles)
      .add(vec3(time.mul(u.windSpeed), float(0), float(0)))
    const n = mx_fractal_noise_float(p, 6, 2.0, 0.5)
    return (n as any).mul(float(0.5)).add(float(0.5)).saturate()
  }

  // Finiteness of a direction as a scalar test (NaN/Inf fail `< 1e20`), plus a
  // sanitized direction with a fixed fallback. Used to gate the reflection/
  // shadow closures: a non-finite reflectDir — viewDir = normalize(camera −
  // surface) degenerates for the fragment directly under the camera during the
  // orbit/fly-to — would otherwise reach BOTH rayShellDir and the horizon dot,
  // and a NaN there survives `·strength` (NaN·0 = NaN), poisoning the scene
  // colour → AgX black/white, atmosphere gone. Scrubbing at the closure entry
  // covers every downstream use.
  const FALLBACK_DIR = vec3(float(0), float(0), float(1))
  const finiteDir = (d: Node): { dir: Node; ok: Node } => {
    const ok = dot(d, d).abs().lessThan(float(1e20))
    return { dir: (ok as any).select(d, FALLBACK_DIR), ok }
  }

  const sampleCloud = (dir: Node): Node => {
    const cov = (rawCoverage(dir) as any).pow(u.contrast)
    const edged = smoothstep(u.coverage, (u.coverage as any).add(float(0.25)), cov)
    const brightness =
      sunDirection != null
        ? (u.nightAmbient as any).add(
            smoothstep(float(-0.15), float(0.25), dot(dir, sunDirection)).mul(
              float(1).sub(u.nightAmbient)
            )
          )
        : float(1)
    const thickness = smoothstep(u.coverage, float(1.0), cov)
    const densityFactor = float(1).sub((u.density as any).mul(thickness))
    const albedo = vec3(u.dayColor).mul(brightness).mul(densityFactor)
    return vec4(albedo, edged)
  }

  const rayShellDir = (origin: Node, dir: Node): Node => {
    // Sphere centred at the ECEF origin, radius u.radius. Solve |O + tD|² = R²,
    // D unit — but in RADIUS-NORMALIZED units. At ECEF scale (|O|,R ≈ 6.4e6) the
    // raw quadratic forms dot(O,O) and R² ≈ 4e13, whose float32 difference loses
    // all precision; for near-vertical rays that yielded a hit ≈ 0 and
    // normalize(≈0) = NaN, which poisoned the scene colour (AgX → black/white,
    // atmosphere never resolved). In units of R every magnitude is O(1).
    const n = (origin as any).div(u.radius) // O / R, |n| ≈ 0.999 (inside shell)
    const b = dot(n, dir)
    const c = dot(n, n).sub(float(1)) // (|O|² − R²)/R² — small, negative
    const disc = (b as any).mul(b).sub(c) // > 0 since c < 0; max() guards rounding
    const s = (b as any).negate().add(sqrt(max(disc, float(0))))
    // n + s·dir lies on the unit sphere by construction, so normalize is safe.
    return normalize((n as any).add((dir as any).mul(s)))
  }

  // Shared path for both effects: intersect a ray with the shell, sample cloud.
  const sampleAlong = (origin: Node, dir: Node): Node =>
    sampleCloud(rayShellDir(origin, dir))

  const reflect = (
    reflectDir: Node,
    originWorld: Node
  ): { color: Node; blend: Node } => {
    // Scrub the reflection ray first — it feeds rayShellDir AND the horizon dot,
    // and reflectDir = reflect(viewDir, n) goes non-finite when the camera sits
    // ≈ on a water point (degenerate viewDir). The sun ray (shadow) doesn't need
    // this — it's a trusted uniform, used unguarded by the shell too.
    const f = finiteDir(reflectDir)
    const s = sampleAlong(originWorld, f.dir)
    // Cull below-horizon reflections. The shell wraps the whole globe, so a
    // reflection ray dipping below the local horizon still hits it — "reflecting"
    // clouds from the lower hemisphere, which reads as fixed streak/line
    // artefacts. Fade to zero as the ray crosses the local horizon (geocentric
    // up = normalized surface position). `gate` also zeroes the whole term when
    // the reflection ray was degenerate (sample then uses the fallback dir).
    const up = normalize(originWorld)
    const horizon = smoothstep(float(0.0), float(0.1), dot(f.dir, up))
    const gate = (f.ok as any).select(float(1), float(0))
    return {
      color: (s as any).rgb,
      blend: (s as any).a.mul(u.reflectionStrength).mul(horizon).mul(gate),
    }
  }

  const shadow = (originWorld: Node): Node => {
    if (sunDirection == null) return float(1)
    const s = sampleAlong(originWorld, sunDirection)
    return float(1).sub((s as any).a.mul(u.shadowStrength))
  }

  const debug = (
    reflectDir: Node,
    originWorld: Node
  ): { color: Node; active: Node } => {
    // Recompute the reflection path's terms and expose each for live inspection.
    const f = finiteDir(reflectDir)
    const hit = rayShellDir(originWorld, f.dir)
    const s = sampleAlong(originWorld, f.dir)
    const up = normalize(originWorld)
    const horizon = smoothstep(float(0.0), float(0.1), dot(f.dir, up))
    const gate = (f.ok as any).select(float(1), float(0))
    const m = u.debugMode as any
    // 1=gate 2=horizon 3=edged coverage 4=hit dir(RGB) 5=scrubbed reflectDir(RGB)
    const c4 = (hit as any).mul(float(0.5)).add(float(0.5))
    const c5 = (f.dir as any).mul(float(0.5)).add(float(0.5))
    const color = m
      .equal(5)
      .select(
        c5,
        m
          .equal(4)
          .select(
            c4,
            m
              .equal(3)
              .select(
                vec3((s as any).a),
                m
                  .equal(2)
                  .select(
                    vec3(horizon),
                    m.equal(1).select(vec3(gate), vec3(float(0)))
                  )
              )
          )
      )
    return { color, active: m.greaterThan(float(0)) }
  }

  const sync = (v: CloudFieldValues): void => {
    u.radius.value = Ellipsoid.WGS84.maximumRadius + v.altitude
    u.opacity.value = v.opacity
    u.coverage.value = v.coverage
    u.windSpeed.value = v.windSpeed
    u.tiles.value = v.tiles
    ;(u.dayColor.value as Color).set(v.dayColor)
    u.nightAmbient.value = v.nightAmbient
    u.density.value = v.density
    u.intensity.value = v.intensity
    u.contrast.value = v.contrast
    u.reflectionStrength.value = v.reflectionStrength
    u.shadowStrength.value = v.shadowStrength
    u.debugMode.value = v.debugMode
  }

  const dispose = (): void => {
    cloudTex?.dispose()
  }

  return {
    uniforms,
    cloudTex,
    sampleCloud,
    rayShellDir,
    reflect,
    shadow,
    debug,
    sync,
    dispose,
  }
}
