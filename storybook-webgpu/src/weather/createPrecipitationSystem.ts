// createPrecipitationSystem.ts — Detachable GPU precipitation engine for the twin.
// Builds a camera-local, ENU-oriented instanced particle field whose per-drop
// motion is computed analytically in the node graph (no compute pass, no storage
// buffers) so it runs on both the WebGPU and WebGL2 backends. Rain and snow are
// one shared system selected by a `mode` uniform. Pure: no React, no scene deps.

import {
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Vector3
} from 'three'
import type { Camera } from 'three'
import {
  abs,
  cos,
  cross,
  float,
  hash,
  instanceIndex,
  length,
  mix,
  mod,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3
} from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

import { Ellipsoid } from '@takram/three-geospatial'

/** Dynamic per-frame values pushed into the system each render. */
export interface PrecipitationValues {
  /** Normalized fall density [0,1] — visible fraction of the drop budget. */
  intensity: number
  /** Master drop opacity [0,1]. */
  opacity: number
  /** 0 = rain, 1 = snow. A hard 0/1 switch; intermediate values blend. */
  mode: number
  /** Altitude visibility [0,1] — 1 near the surface, 0 from orbit. */
  fade: number
  /** Horizontal wind, ENU metres/second (east, north). */
  windEast: number
  windNorth: number
  /** Camera-local box extents and drop dimensions, all in metres. */
  area: number
  height: number
  dropLength: number
  dropWidth: number
  flakeSize: number
  fallSpeedRain: number
  fallSpeedSnow: number
  /** Underwater morph: 0 = above water (rain/snow), 1 = submerged (suspended specks). */
  uw: number
  /** Underwater particle rise speed (m/s, slow upward) + speck size + opacity. */
  uwRise: number
  uwSize: number
  uwOpacity: number
}

export interface PrecipitationSystem {
  /** Add this to the R3F scene (it re-anchors to the camera each frame). */
  object3D: Group
  /** Re-position + ENU-orient the field on the camera. Call every frame. */
  update: (camera: Camera) => void
  /** Push CPU values into the uniforms. Call every frame. */
  sync: (v: PrecipitationValues) => void
  dispose: () => void
}

const POLE = new Vector3(0, 0, 1) // ECEF north pole axis (matches the scene's +Z)

export function createPrecipitationSystem(opts?: {
  maxCount?: number
}): PrecipitationSystem {
  const maxCount = opts?.maxCount ?? 30000

  const u = {
    intensity: uniform(0),
    opacity: uniform(0.5),
    mode: uniform(0),
    fade: uniform(1),
    // Wind as TWO SCALARS, not a vec2 — the WebGPU uniform path re-uploads scalar
    // .value reassignments but NOT in-place mutation of an object uniform (same
    // reference), so a `uniform(Vector2)` mutated via .set() silently stayed at
    // (0,0) and wind had no visible effect. Scalars reassign like `intensity`.
    windEast: uniform(0), // ENU east component, m/s
    windNorth: uniform(0), // ENU north component, m/s
    area: uniform(35),
    height: uniform(45),
    dropLength: uniform(0.9),
    dropWidth: uniform(0.04),
    flakeSize: uniform(0.25),
    fallSpeedRain: uniform(9), // ~raindrop terminal velocity (m/s)
    fallSpeedSnow: uniform(1.2),
    rainColor: uniform(new Color(0.72, 0.78, 0.9)),
    snowColor: uniform(new Color(1, 1, 1)),
    // Underwater morph: uw 0→1 (camera submerged) turns the same drops into slow-
    // rising, sideways-drifting suspended specks — not air bubbles. uwRise is a
    // gentle upward speed (m/s); uwSize a small square speck; uwOpacity its alpha.
    uw: uniform(0),
    uwRise: uniform(0.12),
    uwSize: uniform(0.05),
    uwOpacity: uniform(0.06),
    maxCount: uniform(maxCount)
  }

  // Per-instance deterministic randoms from the instance index — stable across
  // frames, so each drop keeps its scatter/phase without any stored state.
  const idx = float(instanceIndex) as any
  const r1 = hash(idx) as any
  const r2 = hash(idx.add(13.17)) as any
  const r3 = hash(idx.add(31.41)) as any
  const r4 = hash(idx.add(57.93)) as any

  const half = (u.area as any).mul(0.5)

  // Mode-blended physics + shape (0 = rain, 1 = snow). Snow is a square flake.
  const fallSpeed = mix(u.fallSpeedRain, u.fallSpeedSnow, u.mode) as any
  const dropW = mix(u.dropWidth, u.flakeSize, u.mode) as any
  const dropL = mix(u.dropLength, u.flakeSize, u.mode) as any
  // Underwater (uw 0→1) morphs the SAME drops into slow suspended specks — small
  // squares, no streak — so the drop size collapses to uwSize as you submerge.
  const dropWf = mix(dropW, u.uwSize, u.uw) as any
  const dropLf = mix(dropL, u.uwSize, u.uw) as any

  // LOCAL frame, set on the group each frame: +X = east, +Y = north, +Z = UP
  // (right-handed). Signed vertical velocity: air FALLS (−fallSpeed), underwater
  // RISES slowly (+uwRise). Loop the drop through the box via mod(time); r3
  // de-syncs the phase. mod handles the negative (downward) march cleanly.
  const vy = mix((fallSpeed).negate(), u.uwRise, u.uw) as any
  const upPos = mod(r3.mul(u.height).add(vy.mul(time)), u.height).sub(
    (u.height as any).mul(0.5)
  ) // +Z

  // Surface wind drives the drops in air; underwater it fades out (uw→1 ⇒ 0) so
  // submerged specks drift only on the gentle sway below, not at surface wind speed.
  const windE = (u.windEast as any).mul((u.uw as any).oneMinus())
  const windN = (u.windNorth as any).mul((u.uw as any).oneMinus())

  // Horizontal scatter + continuous wind drift (east=X, north=Y), wrapped back
  // into the box so the field is seamless however far the wind carries it.
  const e0 = r1.sub(0.5).mul(u.area)
  const n0 = r2.sub(0.5).mul(u.area)
  const driftE = mod(e0.add(windE.mul(time)).add(half), u.area).sub(half)
  const driftN = mod(n0.add(windN.mul(time)).add(half), u.area).sub(half)

  // Lateral sway: snow flutters (scales with mode); underwater specks drift
  // gently sideways (scales with uw) for a suspended, current-borne look.
  const swayAmp = (u.flakeSize as any).mul(6).mul(u.mode)
  const uwSway = float(1.5).mul(u.uw)
  const ex = driftE
    .add(sin(time.mul(1.6).add(r4.mul(6.2832))).mul(swayAmp))
    .add(sin(time.mul(0.4).add(r4.mul(6.2832))).mul(uwSway))
  const ny = driftN
    .add(cos(time.mul(1.3).add(r4.mul(6.2832))).mul(swayAmp))
    .add(cos(time.mul(0.35).add(r4.mul(6.2832))).mul(uwSway))
  const center = vec3(ex, ny, upPos)

  // Visibility budget: only the first intensity·maxCount drops draw.
  const visible = idx.lessThan((u.maxCount as any).mul(u.intensity))
  const vis = visible.select(float(1), float(0))

  // World-oriented streak quad — a cylindrical billboard about the velocity axis,
  // built in the group's LOCAL frame where the camera sits at the origin. The
  // LENGTH runs along the drop's velocity (wind across X/Y, fall down −Z), so the
  // streak FORESHORTENS to a dot when you look straight up/down the rain (the
  // failure of a fixed-size camera-facing sprite). The WIDTH turns to face the
  // camera (perpendicular to both the velocity and the view ray).
  const velLocal = normalize(vec3(windE, windN, vy)) as any
  const toCam = normalize((center as any).negate()) as any
  // +epsilon keeps the cross finite for a drop sitting exactly on the view axis.
  const widthAxis = normalize(cross(velLocal, toCam).add(vec3(1e-4, 0, 0))) as any
  const g = positionGeometry as any // plane verts: x,y ∈ [−0.5, 0.5]
  const offset = widthAxis.mul(g.x.mul(dropWf)).add(velLocal.mul(g.y.mul(dropLf)))
  const vert = (center as any).add(offset.mul(vis))

  const mat = new MeshBasicNodeMaterial()
  mat.transparent = true
  // Rendered in the post-processing OVERLAY pass (composited AFTER the atmosphere),
  // NOT as scene geometry — so depth is irrelevant and disabled. Depth-writing into
  // the main scene was the bug both ways: writing near drop-depth over far terrain
  // defeated the aerial-perspective pass and exposed raw un-hazed terrain → BLACK
  // streaks; not writing depth let the atmosphere overpaint rain against open sky.
  // The overlay sidesteps both — rain blends over the finished image, consistent
  // against sky, terrain and water.
  mat.depthWrite = false
  mat.depthTest = false
  mat.side = DoubleSide
  mat.positionNode = vert

  // uv.x runs across the streak width, uv.y along its length.
  const a = (uv() as any).sub(0.5)
  const rainAlpha = smoothstep(float(0.5), float(0.0), abs(a.x)).mul(
    smoothstep(float(0.5), float(0.0), abs(a.y))
  )
  const snowAlpha = smoothstep(float(0.5), float(0.0), length(a))
  // Underwater specks read as soft round dots, so blend the shape toward the
  // radial (snow) alpha as you submerge, and swap rain opacity for uwOpacity.
  const airShape = mix(rainAlpha, snowAlpha, u.mode) as any
  const shapeAlpha = mix(airShape, snowAlpha, u.uw) as any
  const effOpacity = mix(u.opacity, u.uwOpacity, u.uw) as any
  mat.opacityNode = shapeAlpha.mul(effOpacity).mul(u.fade).mul(vis)
  mat.colorNode = mix(u.rainColor, u.snowColor, u.mode) as any

  const geometry = new PlaneGeometry(1, 1)
  const mesh = new InstancedMesh(geometry, mat, maxCount)
  mesh.frustumCulled = false // positions live in the node graph, not the bounds
  mesh.renderOrder = 12 // after ocean/atmosphere geometry, for transparency sort
  // InstancedMesh seeds instanceMatrix to zero, which would collapse every drop;
  // the node graph drives placement, so a one-time identity fill is all we need.
  const identity = new Matrix4()
  for (let i = 0; i < maxCount; i++) {
    mesh.setMatrixAt(i, identity)
  }
  mesh.instanceMatrix.needsUpdate = true

  const group = new Group()
  group.add(mesh)

  const _pos = new Vector3()
  const _up = new Vector3()
  const _east = new Vector3()
  const _north = new Vector3()
  const _basis = new Matrix4()

  const update = (camera: Camera): void => {
    camera.getWorldPosition(_pos)
    group.position.copy(_pos)
    // ENU basis at the camera: +X = east, +Y = north, +Z = geocentric up. This
    // order is RIGHT-HANDED (det +1) — makeBasis(east, up, north) would be
    // left-handed and setFromRotationMatrix, assuming a proper rotation, then
    // produces a reflected quaternion that flips "down" depending on view angle
    // (rain appeared to fall up). Re-derived each frame so long flights stay
    // tangent to the globe; degenerate only at the exact poles.
    _up.copy(_pos).normalize()
    _east.crossVectors(POLE, _up)
    if (_east.lengthSq() < 1e-12) {
      _east.set(1, 0, 0)
    } else {
      _east.normalize()
    }
    _north.crossVectors(_up, _east).normalize()
    _basis.makeBasis(_east, _north, _up)
    group.quaternion.setFromRotationMatrix(_basis)
  }

  const sync = (v: PrecipitationValues): void => {
    u.intensity.value = v.intensity
    u.opacity.value = v.opacity
    u.mode.value = v.mode
    u.fade.value = v.fade
    u.windEast.value = v.windEast
    u.windNorth.value = v.windNorth
    u.area.value = v.area
    u.height.value = v.height
    u.dropLength.value = v.dropLength
    u.dropWidth.value = v.dropWidth
    u.flakeSize.value = v.flakeSize
    u.fallSpeedRain.value = v.fallSpeedRain
    u.fallSpeedSnow.value = v.fallSpeedSnow
    u.uw.value = v.uw
    u.uwRise.value = v.uwRise
    u.uwSize.value = v.uwSize
    u.uwOpacity.value = v.uwOpacity
    // Trim the drawn instance range to the visible budget — light rain pays for
    // few drops, the shader still hard-gates the boundary instance.
    mesh.count = Math.max(1, Math.min(maxCount, Math.ceil(maxCount * v.intensity)))
  }

  const dispose = (): void => {
    geometry.dispose()
    mat.dispose()
  }

  return { object3D: group, update, sync, dispose }
}

/** WGS84 max radius — the altitude reference for the wrapper's visibility fade. */
export const EARTH_MAX_RADIUS = Ellipsoid.WGS84.maximumRadius
