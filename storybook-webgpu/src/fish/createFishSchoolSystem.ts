// createFishSchoolSystem.ts — Pure Three.js factory for a shallow-water fish
// school. CPU target-seeking steering keeps fish inside an oblate ellipsoid; one
// InstancedMesh + per-instance attributes (position, forward, atlas frame, phase)
// feed a TSL node material that orients each fish, bends its body with a
// tail-weighted travelling sine wave (ported from threejs-toys), and picks an
// atlas variant. No React, no scene deps. Runs on the WebGPU node backend.

import {
  BoxGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  EdgesGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  LinearFilter,
  Matrix4,
  NoColorSpace,
  PlaneGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Texture
} from 'three'
import {
  attribute,
  cross,
  float,
  frontFacing,
  mix,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  texture as textureNode,
  time,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'

export interface FishSchoolValues {
  count: number
  radiusX: number
  radiusZ: number
  depth: number
  size: number
  speed: number
  wander: number
  turnRate: number
  opacity: number
  currentX: number
  currentZ: number
  /**
   * Flocking strength [0,1]. Blends each fish's heading from its independent
   * interior target (0) toward a shared, time-morphing flow field (1). Because
   * neighbours sample the same field they align into swirling streams — the
   * emergent boids look from the original, with no neighbour search.
   */
  flock: number
  /** Spatial frequency of the flow field — smaller = broader, gentler swirls. */
  flockScale: number
  /**
   * Number of drifting group centres fish cohere toward when flocking. A few
   * (2–5) gives distinct tight schools that travel, merge, and split; fish
   * continually detach to stream between them and rejoin (sometimes a new one).
   */
  flockGroups: number
  /** PBR metalness [0,1]. Keep low (~0) — without an env map, metal reads dark. */
  metalness: number
  /** PBR roughness [0,1]. Lower = sharper, wetter specular gloss. */
  roughness: number
  /** Albedo multiplier [0,1+] — dims the fish so the bright photo doesn't clip
   *  to white under strong scene lighting. The fish's "light intensity" knob. */
  brightness: number
  /** Lifts the lighting normal toward up [0,1] so down-facing bellies still catch
   *  the overhead/surface light instead of going black. 0 = raw normal map. */
  normalLift: number
  /** Tail-beat rate (rad/s) — how fast the body sine wave animates. */
  tailBeat: number
  /** Tail sweep, as a fraction of body length at the tail tip. */
  tailAmplitude: number
  /** Draw a wireframe box around the swim volume (±radiusX, ±depth, ±radiusZ). */
  debug: boolean
}

export interface FishSchoolSystem {
  object3D: Group
  sync: (values: Partial<FishSchoolValues>) => void
  update: (delta: number) => void
  dispose: () => void
}

export interface FishSchoolOptions extends Partial<FishSchoolValues> {
  texture?: Texture
  textureUrl?: string
  /** Tangent-space (OpenGL) normal map, same canvas/frames as the albedo. When
   *  given, fish are lit per-pixel from it (real body curvature) instead of a
   *  flat up normal. */
  normalTexture?: Texture
  normalUrl?: string
  textureFrames?: number
  maxCount?: number
  fishLength?: number
  fishHeight?: number
  /** Body-length segments — more = smoother tail bend (must be >= 2). */
  fishWidthSegments?: number
  color?: Color | string | number
  seed?: number
}

interface FishState {
  /** Atlas variant (column) this fish draws — fixed for its lifetime. */
  frame: number
  /** Wander-noise phase — perpendicular jitter so paths aren't beelines. */
  phase: number
  /** Bonding phase — oscillates each fish in/out of its group (flocking). */
  bondPhase: number
  /** Seconds until a forced retarget, independent of arrival. */
  retarget: number
  position: Vector3
  velocity: Vector3
  /** Roaming goal, an interior point the fish steers toward. */
  target: Vector3
}

const DEFAULT_VALUES: FishSchoolValues = {
  count: 256,
  radiusX: 80,
  radiusZ: 45,
  depth: 8,
  size: 1,
  speed: 4,
  wander: 0.35,
  turnRate: 1.8,
  opacity: 0.92,
  currentX: 0,
  currentZ: 0,
  flock: 0,
  flockScale: 0.02,
  flockGroups: 3,
  metalness: 0,
  roughness: 0.4,
  brightness: 0.4,
  normalLift: 0.5,
  tailBeat: 8,
  tailAmplitude: 0.28,
  debug: false
}

/** Temporal morph rate of the shared flow field (radians/sec of phase). */
const FLOCK_MORPH = 0.25
/** Hard cap on group centres (sizes the attractor scratch arrays). */
const MAX_GROUPS = 8
/** How fast each fish cycles in/out of its group (rad/s). */
const BOND_RATE = 0.22
/** How hard cohesion bends the heading toward the group, vs the flow field. */
const COHESION_GAIN = 2.6

const FORWARD = new Vector3()
const TO_TARGET = new Vector3()
const DESIRED = new Vector3()
const INWARD = new Vector3()
const FLOW = new Vector3()
const COH = new Vector3()
const FLOCKDIR = new Vector3()

export function createFishSchoolSystem(
  options: FishSchoolOptions
): FishSchoolSystem {
  const values: FishSchoolValues = {
    ...DEFAULT_VALUES,
    ...options,
    count: Math.max(0, Math.floor(options.count ?? DEFAULT_VALUES.count))
  }
  const maxCount = Math.max(1, Math.ceil(options.maxCount ?? values.count))
  const textureFrames = Math.max(1, Math.floor(options.textureFrames ?? 8))
  const fishLength = options.fishLength ?? 1
  const fishHeight = options.fishHeight ?? 0.42
  const segments = Math.max(2, Math.floor(options.fishWidthSegments ?? 8))
  const random = mulberry32(options.seed ?? 1)

  const object3D = new Group()
  object3D.frustumCulled = false

  const texture = options.texture ?? loadAtlas(requiredTextureUrl(options))
  const ownsTexture = options.texture == null
  texture.colorSpace = SRGBColorSpace
  // Optional tangent-space normal map (linear, NOT sRGB). Loaded here rather than
  // via the wrapper's Suspense loader so it stays optional (no conditional hook).
  const normal =
    options.normalTexture ??
    (options.normalUrl != null ? loadNormal(options.normalUrl) : null)
  const ownsNormal = options.normalTexture == null && normal != null
  if (normal != null) {
    normal.colorSpace = NoColorSpace
  }

  // Per-instance data. aPos/aFwd are rewritten every frame from CPU motion;
  // aMap/aPhase are fixed at birth (atlas variant + tail-beat de-sync offset).
  const aPosArray = new Float32Array(maxCount * 3)
  const aFwdArray = new Float32Array(maxCount * 3)
  const aMapArray = new Float32Array(maxCount)
  const aPhaseArray = new Float32Array(maxCount)
  const aPos = new InstancedBufferAttribute(aPosArray, 3).setUsage(DynamicDrawUsage)
  const aFwd = new InstancedBufferAttribute(aFwdArray, 3).setUsage(DynamicDrawUsage)
  const aMap = new InstancedBufferAttribute(aMapArray, 1)
  const aPhase = new InstancedBufferAttribute(aPhaseArray, 1)

  // Body-length-segmented quad: local +x = body (head at -0.5, tail at +0.5),
  // +y = height, normal +z. Segments let the vertex bend form a smooth curve.
  const geometry = new PlaneGeometry(1, 1, segments, 1)
  geometry.setAttribute('aPos', aPos)
  geometry.setAttribute('aFwd', aFwd)
  geometry.setAttribute('aMap', aMap)
  geometry.setAttribute('aPhase', aPhase)

  const u = {
    opacity: uniform(values.opacity),
    tailBeat: uniform(values.tailBeat),
    tailAmp: uniform(values.tailAmplitude),
    lenScale: uniform(fishLength * values.size),
    heightScale: uniform(fishHeight * values.size),
    metalness: uniform(values.metalness),
    roughness: uniform(values.roughness),
    brightness: uniform(values.brightness),
    normalLift: uniform(values.normalLift)
  }
  const tint = options.color == null ? new Color(1, 1, 1) : new Color(options.color)

  const material = createFishMaterial(texture, normal, textureFrames, tint, u)
  const mesh = new InstancedMesh(geometry, material, maxCount)
  mesh.frustumCulled = false
  mesh.renderOrder = 10
  // Placement/orientation come from positionNode, not instanceMatrix; identity
  // keeps the auto-instancing transform a harmless no-op before the override.
  const identity = new Matrix4()
  for (let i = 0; i < maxCount; i++) {
    mesh.setMatrixAt(i, identity)
  }
  mesh.instanceMatrix.needsUpdate = true
  object3D.add(mesh)

  // Debug wireframe of the swim volume's bounding box. Unit half-extents (the
  // BoxGeometry spans ±1), scaled in sync to ±radiusX/±depth/±radiusZ.
  const debugMaterial = new LineBasicMaterial({ color: 0x44ddff })
  const debugBox = new LineSegments(
    new EdgesGeometry(new BoxGeometry(2, 2, 2)),
    debugMaterial
  )
  debugBox.frustumCulled = false
  debugBox.visible = false
  object3D.add(debugBox)

  const states = Array.from({ length: maxCount }, (_, index) =>
    createFishState(index, textureFrames, values, random)
  )
  for (let i = 0; i < maxCount; i++) {
    aMapArray[i] = states[i].frame
    aPhaseArray[i] = random() * Math.PI * 2
  }
  aMap.needsUpdate = true
  aPhase.needsUpdate = true

  // Drifting group centres. Each follows an independent slow Lissajous path, so
  // the schools travel and occasionally cross (merge/split). Frequencies/phases
  // are seeded per system so large and small schools drift differently.
  const groupParams = Array.from({ length: MAX_GROUPS }, () => ({
    px: random() * Math.PI * 2,
    py: random() * Math.PI * 2,
    pz: random() * Math.PI * 2,
    fx: 0.05 + random() * 0.08,
    fy: 0.04 + random() * 0.05,
    fz: 0.05 + random() * 0.08
  }))
  const attractors = Array.from({ length: MAX_GROUPS }, () => new Vector3())

  const sync = (next: Partial<FishSchoolValues>): void => {
    // Skip undefined keys so a caller passing a sparse props object can't
    // overwrite a value with undefined and turn a clamp into NaN.
    for (const key of Object.keys(next) as Array<keyof FishSchoolValues>) {
      const value = next[key]
      if (value !== undefined) {
        // Per-key assign: the heterogeneous (number | boolean) value union
        // can't be written through a generic index without a cast; this stays
        // type-safe and still skips undefined.
        Object.assign(values, { [key]: value })
      }
    }
    values.count = Math.max(0, Math.min(maxCount, Math.floor(values.count)))
    values.radiusX = Math.max(0.1, values.radiusX)
    values.radiusZ = Math.max(0.1, values.radiusZ)
    values.depth = Math.max(0.1, values.depth)
    values.size = Math.max(0.01, values.size)
    values.speed = Math.max(0, values.speed)
    values.turnRate = Math.max(0, values.turnRate)
    values.opacity = Math.max(0, Math.min(1, values.opacity))
    values.flock = Math.max(0, Math.min(1, values.flock))
    values.flockScale = Math.max(1e-4, values.flockScale)
    values.flockGroups = Math.max(1, Math.min(MAX_GROUPS, Math.round(values.flockGroups)))
    values.tailBeat = Math.max(0, values.tailBeat)
    values.tailAmplitude = Math.max(0, values.tailAmplitude)
    u.opacity.value = values.opacity
    u.tailBeat.value = values.tailBeat
    u.tailAmp.value = values.tailAmplitude
    u.lenScale.value = fishLength * values.size
    u.heightScale.value = fishHeight * values.size
    values.metalness = Math.max(0, Math.min(1, values.metalness))
    values.roughness = Math.max(0, Math.min(1, values.roughness))
    u.metalness.value = values.metalness
    u.roughness.value = values.roughness
    values.brightness = Math.max(0, values.brightness)
    u.brightness.value = values.brightness
    values.normalLift = Math.max(0, Math.min(1, values.normalLift))
    u.normalLift.value = values.normalLift
    debugBox.visible = values.debug
    debugBox.scale.set(values.radiusX, values.depth, values.radiusZ)
    // Match the rendered volume: raised so its bottom sits at the origin.
    debugBox.position.y = values.depth
    ensureVisibleFishAreInVolume(states, values, random)
  }

  let elapsed = 0
  const update = (delta: number): void => {
    const dt = Math.min(Math.max(delta, 0), 1 / 20)
    elapsed += dt

    const groups = Math.max(1, Math.min(MAX_GROUPS, Math.round(values.flockGroups)))
    if (values.flock > 0) {
      for (let k = 0; k < groups; k++) {
        const p = groupParams[k]
        attractors[k].set(
          Math.cos(elapsed * p.fx + p.px) * values.radiusX * 0.55,
          Math.sin(elapsed * p.fy + p.py) * values.depth * 0.5,
          Math.sin(elapsed * p.fz + p.pz) * values.radiusZ * 0.55
        )
      }
    }

    for (let i = 0; i < values.count; i++) {
      const state = states[i]
      updateFish(state, values, dt, elapsed, attractors, groups, random)
      const { position, velocity } = state
      // Volume is simulated centred on y=0 (±depth) but rendered raised by
      // `depth` so it sits ABOVE the origin (bottom at y=0) — the school then
      // hangs below an anchor placed at its top, not straddling it.
      aPosArray[i * 3] = position.x
      aPosArray[i * 3 + 1] = position.y + values.depth
      aPosArray[i * 3 + 2] = position.z
      FORWARD.copy(velocity)
      FORWARD.y *= 0.35
      if (FORWARD.lengthSq() < 1e-8) {
        FORWARD.set(1, 0, 0)
      }
      FORWARD.normalize()
      aFwdArray[i * 3] = FORWARD.x
      aFwdArray[i * 3 + 1] = FORWARD.y
      aFwdArray[i * 3 + 2] = FORWARD.z
    }

    mesh.count = values.count
    aPos.needsUpdate = true
    aFwd.needsUpdate = true
  }

  sync(values)
  update(0)

  const dispose = (): void => {
    geometry.dispose()
    if (ownsTexture) {
      texture.dispose()
    }
    if (ownsNormal && normal != null) {
      normal.dispose()
    }
    material.dispose()
    debugBox.geometry.dispose()
    debugMaterial.dispose()
  }

  return { object3D, sync, update, dispose }
}

function requiredTextureUrl(options: FishSchoolOptions): string {
  if (options.textureUrl == null) {
    throw new Error('createFishSchoolSystem requires texture or textureUrl')
  }
  return options.textureUrl
}

function loadAtlas(url: string): Texture {
  const texture = new TextureLoader().load(url)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  return texture
}

function loadNormal(url: string): Texture {
  const texture = new TextureLoader().load(url)
  texture.colorSpace = NoColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  return texture
}

interface FishUniforms {
  opacity: ReturnType<typeof uniform>
  tailBeat: ReturnType<typeof uniform>
  tailAmp: ReturnType<typeof uniform>
  lenScale: ReturnType<typeof uniform>
  heightScale: ReturnType<typeof uniform>
  metalness: ReturnType<typeof uniform>
  roughness: ReturnType<typeof uniform>
  brightness: ReturnType<typeof uniform>
  normalLift: ReturnType<typeof uniform>
}

/**
 * Builds the fish node material (PBR, lit by the scene). The vertex stage
 * reconstructs the per-fish orientation from the `aFwd` attribute (positionNode
 * fully overrides the instance matrix, so the basis must be rebuilt here), bends
 * the body with the threejs-toys tail wave — `sin(phase + dTail·1.5π)·smoothstep(2,0,dTail)`,
 * max at the tail and zero at the head — and offsets along the lateral (side)
 * axis. The atlas variant (`aMap`) feeds the albedo. If a normal map is supplied
 * it drives per-pixel lighting (real body curvature) via a TBN built from the
 * per-fish axes; otherwise lighting falls back to a flat up normal.
 */
function createFishMaterial(
  atlas: Texture,
  normal: Texture | null,
  frameCount: number,
  tint: Color,
  u: FishUniforms
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  // Opaque alpha-cutout: the atlas alpha cuts the silhouette (alphaTest), depth
  // is written so fish occlude each other correctly, and `transparent` only
  // matters if opacity is dialled below 1 — so they don't read as see-through.
  material.transparent = true
  material.depthWrite = true
  material.alphaTest = 0.5
  material.side = DoubleSide

  const aPos = attribute('aPos', 'vec3')
  const aFwd = attribute('aFwd', 'vec3')
  const aMap = attribute('aMap', 'float')
  const aPhase = attribute('aPhase', 'float')

  const g = positionGeometry
  // dTail: 0 at the tail tip (+x), 2 at the head (−x); amplitude ramps to tail.
  const dTail = float(0.5).sub(g.x).mul(2)
  const ramp = smoothstep(2, 0, dTail)
  const wavePhase = aPhase.add(time.mul(u.tailBeat))
  const bend = sin(wavePhase.add(dTail.mul(Math.PI * 1.5)))
    .mul(ramp)
    .mul(u.tailAmp)

  const up = vec3(0, 1, 0)
  const forward = normalize(aFwd)
  const side = normalize(cross(forward, up))
  // Local-space (group-relative) world position: place at aPos, lay the body
  // along −forward (so the head leads), height along up, tail sweep along side.
  const local = aPos
    .add(forward.mul(g.x.mul(u.lenScale).negate()))
    .add(up.mul(g.y.mul(u.heightScale)))
    .add(side.mul(bend.mul(u.lenScale)))
  material.positionNode = local

  const frameUv = vec2(aMap.add(uv().x).div(frameCount), uv().y)

  // Lighting normal. With a normal map, decode its tangent-space normal and
  // rotate it into view space through a TBN built from the per-fish axes — U
  // (head→tail) = −forward, V (up the sprite) = up, face = side — so the fish
  // catches light with real body curvature. Flip on back faces (double-sided).
  // Without a map, fall back to a flat up normal (consistent, no heading swing).
  if (normal != null) {
    const ts = textureNode(normal, frameUv).rgb.mul(2).sub(1)
    const tbn = forward.negate().mul(ts.x).add(up.mul(ts.y)).add(side.mul(ts.z))
    // Lift toward up so down-facing bellies still catch the overhead light
    // instead of dropping to black; 0 keeps the raw normal map.
    const localNormal = mix(tbn, up, u.normalLift)
    const viewNormal = transformNormalToView(localNormal)
    material.normalNode = frontFacing.select(viewNormal, viewNormal.negate())
  } else {
    material.normalNode = transformNormalToView(up)
  }
  material.metalnessNode = u.metalness
  material.roughnessNode = u.roughness

  const sample = textureNode(atlas, frameUv)
  // `brightness` scales the albedo down so the bright silvery-fish photo doesn't
  // clip to white under the scene's intense sun — the fish's own light knob.
  material.colorNode = sample.rgb
    .mul(vec3(tint.r, tint.g, tint.b))
    .mul(u.brightness)
  material.opacityNode = sample.a.mul(u.opacity)

  return material
}

function createFishState(
  index: number,
  frameCount: number,
  values: FishSchoolValues,
  random: () => number
): FishState {
  const position = sampleVolume(values, random)
  const angle = random() * Math.PI * 2
  const velocity = new Vector3(
    Math.cos(angle) * values.speed,
    (random() - 0.5) * values.speed * 0.12,
    Math.sin(angle) * values.speed
  )
  const state: FishState = {
    frame: Math.floor(random() * frameCount),
    phase: random() * Math.PI * 2,
    bondPhase: random() * Math.PI * 2,
    retarget: 0,
    position,
    velocity,
    target: new Vector3()
  }
  pickInteriorTarget(state, values, random)
  return state
}

/**
 * Re-roll a fish's roaming goal: a point well inside the ellipsoid (capped at
 * 0.85 of each radius so goals never sit on the shell), plus a fresh countdown
 * to the next forced retarget. Per-fish targets keep the school dispersed and
 * are the reason fish no longer drift onto and stack along the boundary.
 */
function pickInteriorTarget(
  state: FishState,
  values: FishSchoolValues,
  random: () => number
): void {
  const r = Math.sqrt(random()) * 0.85
  const theta = random() * Math.PI * 2
  state.target.set(
    Math.cos(theta) * r * values.radiusX,
    (random() * 2 - 1) * values.depth * 0.7,
    Math.sin(theta) * r * values.radiusZ
  )
  state.retarget = 2.5 + random() * 4
}

/**
 * Target-seeking steering. Each fish heads toward an interior roaming goal,
 * re-rolled on arrival or when its countdown expires, with perpendicular wander
 * jitter, a soft inward bias near the shell, and a gentle current drift. The
 * heading is steered (lerped) toward the goal at `turnRate`, then renormalized
 * to `speed` so the swim pace stays constant. Crucially there is NO standing
 * center force balanced against the current, so fish do not pool on the
 * downstream boundary; the hard clamp is only a NaN/overshoot safety net.
 *
 * `flock` blends the heading away from the independent target and toward a
 * flocking direction: the shared flow field (alignment/streaming) plus a pull
 * toward the nearest drifting group centre (cohesion). A per-fish bond phase
 * fades that cohesion in and out, so fish tighten into a school, then detach
 * and stream along the flow before rejoining — schools that flow in and out.
 */
function updateFish(
  state: FishState,
  values: FishSchoolValues,
  delta: number,
  elapsed: number,
  attractors: Vector3[],
  groups: number,
  random: () => number
): void {
  const { position, velocity, target } = state

  state.retarget -= delta
  TO_TARGET.copy(target).sub(position)
  const arrive = Math.max(values.radiusX, values.radiusZ) * 0.08
  if (state.retarget <= 0 || TO_TARGET.lengthSq() < arrive * arrive) {
    pickInteriorTarget(state, values, random)
    TO_TARGET.copy(target).sub(position)
  }

  DESIRED.copy(TO_TARGET)
  if (DESIRED.lengthSq() < 1e-8) {
    DESIRED.copy(velocity)
  }
  DESIRED.normalize()

  // Flock: swim along the shared flow field, pulled toward the nearest group
  // centre. The bond fades cohesion in/out so membership churns; the whole
  // flocking heading then blends over the private roam by `flock`.
  state.bondPhase += delta * BOND_RATE
  if (values.flock > 0) {
    flowDirection(position, elapsed, values.flockScale, FLOW)

    let nearest = 0
    let nearestD2 = Infinity
    for (let k = 0; k < groups; k++) {
      const d2 = position.distanceToSquared(attractors[k])
      if (d2 < nearestD2) {
        nearestD2 = d2
        nearest = k
      }
    }
    COH.copy(attractors[nearest]).sub(position)
    const dist = Math.sqrt(nearestD2)
    // Pull in from outside the group; go slack inside so fish mill in a ball
    // rather than collapsing to the point.
    const groupRadius = Math.max(values.radiusX, values.radiusZ) * 0.14
    const pullIn = smoothstepScalar(groupRadius * 0.5, groupRadius * 2.5, dist)
    const bond = 0.5 + 0.5 * Math.sin(state.bondPhase)
    const cohesion = pullIn * bond * COHESION_GAIN
    if (COH.lengthSq() > 1e-8) {
      COH.normalize()
    }

    FLOCKDIR.copy(FLOW).addScaledVector(COH, cohesion)
    if (FLOCKDIR.lengthSq() < 1e-8) {
      FLOCKDIR.copy(FLOW)
    }
    FLOCKDIR.normalize()

    DESIRED.lerp(FLOCKDIR, values.flock)
    if (DESIRED.lengthSq() < 1e-8) {
      DESIRED.copy(FLOCKDIR)
    }
    DESIRED.normalize()
  }

  // Perpendicular (horizontal) wander so paths meander instead of beelining,
  // plus a small vertical flutter. Per-fish phase keeps the school de-synced.
  // Damped while flocking so the streams stay coherent.
  state.phase += delta * (0.5 + values.wander * 1.5)
  const wanderScale = 1 - values.flock * 0.6
  const sideX = -DESIRED.z
  const sideZ = DESIRED.x
  const sideMag = Math.hypot(sideX, sideZ)
  const sideLen = sideMag > 1e-8 ? sideMag : 1
  const jitter = Math.sin(state.phase * 1.7) * values.wander * 0.9 * wanderScale
  DESIRED.x += (sideX / sideLen) * jitter
  DESIRED.z += (sideZ / sideLen) * jitter
  DESIRED.y += Math.sin(state.phase * 0.9) * values.wander * 0.25 * wanderScale

  // Soft boundary: ramp an inward bias once a fish nears the shell so it banks
  // away well before the hard clamp — replaces the old shell-attracting force.
  const nx = position.x / values.radiusX
  const ny = position.y / values.depth
  const nz = position.z / values.radiusZ
  const d = Math.sqrt(nx * nx + ny * ny + nz * nz)
  if (d > 0.82) {
    INWARD.set(-nx / values.radiusX, -ny / values.depth, -nz / values.radiusZ)
    if (INWARD.lengthSq() > 1e-8) {
      INWARD.normalize()
      DESIRED.addScaledVector(INWARD, (d - 0.82) * 6)
    }
  }

  // Gentle current bias — a directional nudge, not an unbounded accumulator.
  DESIRED.x += values.currentX * 0.15
  DESIRED.z += values.currentZ * 0.15

  if (DESIRED.lengthSq() < 1e-8) {
    DESIRED.copy(velocity)
  }
  DESIRED.normalize().multiplyScalar(values.speed)

  const steer = Math.min(delta * (0.6 + values.turnRate), 1)
  velocity.lerp(DESIRED, steer)
  velocity.y *= 0.96
  const speed = velocity.length()
  if (speed > 1e-5) {
    velocity.multiplyScalar(values.speed / speed)
  }

  position.addScaledVector(velocity, delta)
  constrainToVolume(position, values)
}

/**
 * Shared, time-morphing flow field — the cheap stand-in for the original's
 * gradient-noise boids field. A smooth scalar angle built from a few sines of
 * position drives a horizontal heading (cos/sin) plus a gentle vertical sway.
 * Because the angle varies slowly in space, nearby fish read near-identical
 * headings and converge into swirling streams; because it morphs in time, the
 * streams evolve. O(1) per fish, no neighbour queries. Writes a unit vector.
 */
function flowDirection(
  position: Vector3,
  elapsed: number,
  scale: number,
  out: Vector3
): void {
  const t = elapsed * FLOCK_MORPH
  const angle =
    (Math.sin(position.x * scale + t) +
      Math.sin(position.z * scale * 1.3 - t * 0.8) +
      Math.sin((position.x + position.z) * scale * 0.5 + t * 0.6)) *
    Math.PI
  out.set(
    Math.cos(angle),
    Math.sin(position.y * scale * 2 + t) * 0.3,
    Math.sin(angle)
  )
  if (out.lengthSq() > 1e-8) {
    out.normalize()
  }
}

function ensureVisibleFishAreInVolume(
  states: FishState[],
  values: FishSchoolValues,
  random: () => number
): void {
  for (let i = 0; i < values.count; i++) {
    constrainToVolume(states[i].position, values, random)
  }
}

function sampleVolume(values: FishSchoolValues, random: () => number): Vector3 {
  const r = Math.sqrt(random())
  const theta = random() * Math.PI * 2
  const y = (random() * 2 - 1) * values.depth
  return new Vector3(
    Math.cos(theta) * r * values.radiusX,
    y,
    Math.sin(theta) * r * values.radiusZ
  )
}

function constrainToVolume(
  position: Vector3,
  values: FishSchoolValues,
  random?: () => number
): void {
  if (random != null && !Number.isFinite(position.lengthSq())) {
    position.copy(sampleVolume(values, random))
    return
  }

  const nx = position.x / values.radiusX
  const ny = position.y / values.depth
  const nz = position.z / values.radiusZ
  const d = Math.sqrt(nx * nx + ny * ny + nz * nz)

  if (d > 1) {
    position.x /= d
    position.y /= d
    position.z /= d
  }
}

/** Scalar smoothstep — the CPU counterpart of the TSL `smoothstep` node. */
function smoothstepScalar(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
