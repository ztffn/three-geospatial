// TurbineCables — auto-routed subsea inter-array cables for the offshore farm.
// Self-contained R3F drop-in: given turbine base positions + a connection point
// (ship/substation), it auto-builds a minimum-spanning-tree topology, BAKES each
// cable with a Verlet rope draped onto the seabed, and renders the frozen result
// as static TubeGeometry in the LOCAL ENU frame (group matrix carries ECEF).
// Hard-won constraints:
// (1) never bake ECEF-magnitude coordinates into vertex buffers — float32 at
//     ~6.4e6 m quantizes to ~0.5 m and the tubes visibly jitter;
// (2) the floor comes from terrain raycasts, but offshore photogrammetry is
//     ±30 m of noise that streams in/out with the camera — so the sampled
//     floor is smoothed, clamped below sea level, and LOCKED once raycast
//     coverage stops improving. Re-baking on every tiles-load-end (or on a
//     median + hysteresis) made the cables visibly move every few seconds.

import { useEffect, useMemo, useRef, type FC } from 'react'
import {
  CatmullRomCurve3,
  Matrix4,
  Raycaster,
  TubeGeometry,
  Vector3,
  type BufferGeometry,
  type Object3D
} from 'three'
import { MeshLambertNodeMaterial } from 'three/webgpu'

import { Ellipsoid } from '@takram/three-geospatial'

// Serializable result of a converged bake: local-ENU node paths + the input
// signature they were baked from. Commit one (cable-bake.json) so production
// loads skip the raycasts + Verlet solve entirely.
export interface CableBakeSnapshot {
  sig: string
  target: [number, number, number]
  cables: Array<Array<[number, number, number]>>
}

export interface TurbineCablesProps {
  // Turbine base positions in ECEF (world space) — typically the `placements`
  // positions from TurbineFarm. Empty array renders nothing.
  bases: Vector3[]
  // The hub every string runs toward in ECEF: ship deck attach, or substation.
  connectionPoint: Vector3
  // ENU origin for the local sim frame (the farm fly-to target, ECEF). Gravity
  // is -up in this frame; baked nodes are mapped back to ECEF for rendering.
  target: Vector3
  // FALLBACK floor depth below the ENU origin, metres — used where terrain
  // raycasts have no coverage (or no terrain is supplied).
  seabedDepth?: number
  // Terrain tile group: per-node downward raycasts at bake time give the
  // floor the cables drape onto.
  terrain?: Object3D | null
  // Bump to re-sample after the terrain changes (e.g. on 'tiles-load-end').
  // Only triggers a re-bake while coverage is still improving — see lockRef.
  terrainVersion?: number
  // Ceiling for sampled floors (local y, metres). Offshore photogrammetry
  // bakes the SEA SURFACE as geometry; hits near/above the rendered ocean are
  // junk and get clamped under this. Callers pass ~(ocean height − margin).
  maxFloorY?: number
  // Extra cable length beyond the descend-run-ascend minimum, as a fraction of
  // the horizontal span. Small values rest taut on the floor; larger values add
  // visible slack/bight. Default 0.05.
  slack?: number
  // Tube radius, metres.
  radius?: number
  // Verlet nodes per cable (also tube path resolution).
  segments?: number
  // Hex cable colour.
  color?: number
  // Pre-baked snapshot: when its sig matches the current inputs, geometry is
  // built directly from the stored node paths — no raycasts, no solve.
  baked?: CableBakeSnapshot | null
  // Manual re-bake trigger: incrementing clears the coverage lock + deferral
  // state and solves immediately with whatever the raycasts see right now
  // (bypasses the first-bake coverage threshold — the user has judged the
  // tiles to be loaded).
  rebakeNonce?: number
  // Called with a fresh snapshot after every live bake (NOT when loading from
  // `baked`). The story keeps the latest in a ref for the copy-bake button —
  // must not setState (fires during render).
  onBake?: (snapshot: CableBakeSnapshot) => void
}

// Prim's MST over [connectionPoint, ...bases] using straight-line ECEF distance.
// Returns index pairs into that combined array. A tree rooted near the hub gives
// the radial daisy-chain look real array cabling has, without hand-authoring.
function minimumSpanningTree(points: Vector3[]): Array<[number, number]> {
  const n = points.length
  if (n < 2) return []
  const inTree = new Array<boolean>(n).fill(false)
  const bestDist = new Array<number>(n).fill(Infinity)
  const bestFrom = new Array<number>(n).fill(-1)
  const edges: Array<[number, number]> = []
  inTree[0] = true
  for (let j = 1; j < n; j++) {
    bestDist[j] = points[0].distanceTo(points[j])
    bestFrom[j] = 0
  }
  for (let added = 1; added < n; added++) {
    let pick = -1
    let pickDist = Infinity
    for (let j = 0; j < n; j++) {
      if (!inTree[j] && bestDist[j] < pickDist) {
        pickDist = bestDist[j]
        pick = j
      }
    }
    if (pick < 0) break
    inTree[pick] = true
    edges.push([bestFrom[pick], pick])
    for (let j = 0; j < n; j++) {
      if (!inTree[j]) {
        const d = points[pick].distanceTo(points[j])
        if (d < bestDist[j]) {
          bestDist[j] = d
          bestFrom[j] = pick
        }
      }
    }
  }
  return edges
}

// Bake one cable in the local ENU frame. Endpoints a/b are pinned at the surface
// (y from their real height); interior nodes fall under gravity, are length-
// constrained to a rest length long enough to reach the floor and back, and are
// clamped to floors[i]. The relaxation is deterministic (fixed dt, fixed
// iteration counts) so the same inputs always bake the same geometry.
function bakeCable(
  a: Vector3,
  b: Vector3,
  floors: number[],
  slack: number,
  segments: number
): Vector3[] {
  const N = Math.max(2, segments)
  const horiz = Math.hypot(b.x - a.x, b.z - a.z)
  // Slack goes HORIZONTAL, like real laid cable: the path is seeded along a
  // sine meander perpendicular to the chord, sized so its arc length absorbs
  // the slack, and the rope's rest length matches the SEED exactly. Any
  // surplus between rest length and the seeded path is rope the floor-clamped
  // solver can only fold UPWARD into floating arches — so the amplitude is
  // found by bisection on the measured polyline length, never an analytic
  // approximation (the small-slope formula under-absorbs badly at slack ≳0.1,
  // which is precisely what produced the giant sky arcs).
  const e = Math.max(0, slack)
  const halfWaves = Math.max(1, Math.round(horiz / 450))
  // Unit lateral direction in the horizontal plane (perpendicular to chord).
  const inv = 1 / (horiz || 1e-6)
  const perpX = -(b.z - a.z) * inv
  const perpZ = (b.x - a.x) * inv

  const descents = Math.max(0, a.y - floors[0]) + Math.max(0, b.y - floors[N])
  const targetLen = horiz * (1 + e) + descents

  const seed = (amp: number): Vector3[] => {
    const nodes: Vector3[] = []
    for (let i = 0; i <= N; i++) {
      const t = i / N
      const lateral = amp * Math.sin(Math.PI * halfWaves * t)
      const p = new Vector3().lerpVectors(a, b, t)
      p.x += perpX * lateral
      p.z += perpZ * lateral
      nodes.push(p)
    }
    return nodes
  }
  const measure = (nodes: Vector3[]): number => {
    let len = 0
    for (let i = 0; i < nodes.length - 1; i++) {
      len += nodes[i].distanceTo(nodes[i + 1])
    }
    return len
  }

  let lo = 0
  let hi = (4 * horiz) / (Math.PI * halfWaves) + 1
  for (let it = 0; it < 32; it++) {
    const mid = (lo + hi) / 2
    if (measure(seed(mid)) < targetLen) lo = mid
    else hi = mid
  }
  const pos = seed((lo + hi) / 2)
  // PER-SEGMENT rest lengths, each equal to its own seeded length. A uniform
  // rest (total/N) leaves the unevenly-sampled sine locally COMPRESSED in
  // places even when the total matches — and any local compression feeds the
  // floor ratchet (down is clamped, up is free) until it erupts as a sky
  // arch. Zero initial strain everywhere makes vertical buckling impossible:
  // gravity and descents can only STRETCH segments, and tension is stable.
  const rest: number[] = []
  for (let i = 0; i < N; i++) {
    rest.push(pos[i].distanceTo(pos[i + 1]))
  }
  const prev = pos.map(p => p.clone())

  const dt = 1 / 60
  const g = -9.81 * dt * dt // gravity contribution per Verlet step
  const STEPS = 240
  const ITER = 20
  // PER-NODE ceiling — the invariant is "never free-floating", not "below
  // the attachments". A node may rest ON the floor (even a floor above the
  // attachments: a cable climbing a seabed ridge is physically correct), and
  // it may hang along the straight line between attachments (the descents),
  // but it may never be far above BOTH. A scalar ceiling can't express this:
  // clamping to the attachments tunnels cables UNDER high seabed; letting
  // the floor win builds sky arches on junk floor humps. The max of the two
  // references per node forbids exactly the pathology and nothing else.
  const ceil: number[] = []
  for (let i = 0; i <= N; i++) {
    const chordY = a.y + (b.y - a.y) * (i / N)
    ceil.push(Math.max(floors[i], chordY) + 2)
  }
  for (let s = 0; s < STEPS; s++) {
    // Integrate interior nodes (endpoints pinned).
    for (let i = 1; i < N; i++) {
      const p = pos[i]
      const pr = prev[i]
      const vx = (p.x - pr.x) * 0.98
      const vy = (p.y - pr.y) * 0.98
      const vz = (p.z - pr.z) * 0.98
      pr.copy(p)
      p.set(p.x + vx, p.y + vy + g, p.z + vz)
    }
    // Relax distance constraints + clamp to the seabed floor.
    for (let k = 0; k < ITER; k++) {
      for (let i = 0; i < N; i++) {
        const p0 = pos[i]
        const p1 = pos[i + 1]
        const dx = p1.x - p0.x
        const dy = p1.y - p0.y
        const dz = p1.z - p0.z
        const d = Math.hypot(dx, dy, dz) || 1e-6
        const diff = (d - rest[i]) / d
        // Endpoints (index 0 and N) are pinned; interior nodes share correction.
        const w0 = i === 0 ? 0 : 0.5
        const w1 = i + 1 === N ? 0 : 0.5
        p0.set(p0.x + dx * diff * w0, p0.y + dy * diff * w0, p0.z + dz * diff * w0)
        p1.set(p1.x - dx * diff * w1, p1.y - dy * diff * w1, p1.z - dz * diff * w1)
      }
      for (let i = 1; i < N; i++) {
        // Independent clamps; floor ≤ ceil[i] by construction, so order is
        // safe and a node always has a valid band to live in.
        if (pos[i].y < floors[i]) pos[i].y = floors[i]
        if (pos[i].y > ceil[i]) pos[i].y = ceil[i]
      }
    }
  }
  return pos
}

const _floorRay = new Raycaster()

export const TurbineCables: FC<TurbineCablesProps> = ({
  bases,
  connectionPoint,
  target,
  seabedDepth = 35,
  terrain = null,
  terrainVersion = 0,
  maxFloorY = 0,
  slack = 0.3,
  radius = 0.7,
  segments = 28,
  color = 0xffd60a,
  baked = null,
  rebakeNonce = 0,
  onBake
}) => {
  const material = useMemo(
    () => new MeshLambertNodeMaterial({ color }),
    [color]
  )

  // Floor lock: once sampled with coverage that stops improving, the floors
  // are FROZEN for this topology — later tiles-load-end events don't move the
  // cables. Coverage can only improve a bounded number of times, so bakes
  // converge (typically 2-3 during initial tile streaming, then never again).
  const lockRef = useRef<{
    topoSig: string
    bestCoverage: number
    floors: number[][]
  } | null>(null)
  // Geometry cache: identical bake inputs return identical geometry identity,
  // so locked floors → zero rebuilds.
  const cacheRef = useRef<{
    sig: string
    value: { enuToEcef: Matrix4; geometries: BufferGeometry[] }
  } | null>(null)
  // First-bake deferral counter (per input signature) — see below.
  const deferRef = useRef<{ sig: string; attempts: number } | null>(null)
  // Manual rebake bookkeeping: nonce change wipes lock/deferral and forces an
  // immediate solve on the next evaluation.
  const nonceRef = useRef(rebakeNonce)
  const forcedRef = useRef(false)
  // True after any manual rebake — live results outrank the committed
  // snapshot until the page reloads.
  const liveOverrideRef = useRef(false)

  const { enuToEcef, geometries } = useMemo(() => {
    // Manual rebake: wipe converged state, solve fresh this evaluation.
    if (nonceRef.current !== rebakeNonce) {
      nonceRef.current = rebakeNonce
      lockRef.current = null
      deferRef.current = null
      cacheRef.current = null
      forcedRef.current = true
      liveOverrideRef.current = true
    }
    // Local ENU basis at the farm target. Columns: x=east, y=up, z=north — so
    // gravity is simply -y.
    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    Ellipsoid.WGS84.getEastNorthUpVectors(target, east, north, up)
    const enuToEcef = new Matrix4().makeBasis(east, up, north).setPosition(target)
    if (bases.length === 0) {
      return { enuToEcef, geometries: [] as BufferGeometry[] }
    }
    const ecefToEnu = enuToEcef.clone().invert()

    // Endpoints in local frame: hub first, then every base.
    const ecefPoints = [connectionPoint, ...bases]
    const localPoints = ecefPoints.map(p => p.clone().applyMatrix4(ecefToEnu))
    const edges = minimumSpanningTree(ecefPoints)
    const N = Math.max(2, segments)
    const fallbackY = -seabedDepth + radius
    const r4 = (v: number): number => Math.round(v * 4) / 4

    // Input signature shared by the bake lock and the snapshot — everything
    // the geometry depends on EXCEPT the sampled floors (so a committed
    // snapshot can be validated without raycasting anything).
    const inputSig = JSON.stringify([
      localPoints.map(p => [r4(p.x), r4(p.y), r4(p.z)]),
      [r4(target.x), r4(target.y), r4(target.z)],
      seabedDepth,
      maxFloorY,
      slack,
      radius,
      segments,
    ])

    // Pre-baked snapshot short-circuit: matching sig → geometry straight from
    // the stored node paths. No raycasts, no Verlet, instant and identical on
    // every load. A manual Rebake (forcedRef) MUST bypass this — and once a
    // rebake has happened, the live result stays in charge for the rest of
    // the session (liveOverrideRef): without that, the very next
    // tiles-load-end re-evaluates, the sig still matches, and the stale
    // snapshot silently replaces the geometry the user just baked.
    if (
      !forcedRef.current &&
      !liveOverrideRef.current &&
      baked != null &&
      baked.sig === inputSig &&
      baked.cables.length === edges.length
    ) {
      const cachedSig = 'baked:' + inputSig
      if (cacheRef.current?.sig === cachedSig) return cacheRef.current.value
      const geometries = baked.cables.map(nodes => {
        const points = nodes.map(([x, y, z]) => new Vector3(x, y, z))
        return new TubeGeometry(
          new CatmullRomCurve3(points),
          segments * 2,
          radius,
          6,
          false
        )
      })
      console.log('[TurbineCables] loaded baked snapshot (no solve)')
      const value = { enuToEcef, geometries }
      cacheRef.current = { sig: cachedSig, value }
      return value
    }

    // ── Floor sampling ────────────────────────────────────────────────────
    const scratchOrigin = new Vector3()
    const scratchDir = new Vector3()
    const sampleFloorY = (x: number, z: number): number | null => {
      if (terrain == null) return null
      scratchOrigin.set(x, 100, z).applyMatrix4(enuToEcef)
      scratchDir.copy(scratchOrigin).normalize().negate() // ECEF down
      _floorRay.set(scratchOrigin, scratchDir)
      _floorRay.far = 200 + seabedDepth
      ;(_floorRay as any).firstHitOnly = true
      const hit = _floorRay.intersectObject(terrain, true)[0]
      if (hit == null) return null
      // Sea-level ceiling: offshore photogrammetry bakes the sea surface as
      // geometry, so hits near/above the rendered ocean are junk ("cables
      // above water"). The tube rests its SURFACE on the floor → + radius.
      return Math.min(hit.point.applyMatrix4(ecefToEnu).y, maxFloorY) + radius
    }

    // Per-edge raw samples along the straight chord.
    let hits = 0
    let total = 0
    const rawPerEdge = edges.map(([i, j]) => {
      const a = localPoints[i]
      const b = localPoints[j]
      const raw: Array<number | null> = []
      for (let n = 0; n <= N; n++) {
        const t = n / N
        const f = sampleFloorY(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)
        raw.push(f)
        total++
        if (f != null) hits++
      }
      return raw
    })
    const coverage = total > 0 ? hits / total : 0

    // ── First-bake deferral ───────────────────────────────────────────────
    // Tiles stream in after mount, so the first bake would otherwise run at
    // ~0% coverage (flat fallback) and the cables would visibly JUMP when the
    // real floors arrive. With terrain supplied but coverage still poor, and
    // no previous bake to keep showing, render nothing and wait for the next
    // tiles-load-end. Bounded so sparse offshore coverage can't defer forever;
    // terrain-less callers and committed snapshots never defer.
    const lock = lockRef.current?.topoSig === inputSig ? lockRef.current : null
    const MIN_FIRST_COVERAGE = 0.6
    const MAX_DEFER_ATTEMPTS = 8
    if (
      !forcedRef.current &&
      terrain != null &&
      lock == null &&
      coverage < MIN_FIRST_COVERAGE
    ) {
      const defer =
        deferRef.current?.sig === inputSig
          ? deferRef.current
          : { sig: inputSig, attempts: 0 }
      defer.attempts++
      deferRef.current = defer
      if (defer.attempts <= MAX_DEFER_ATTEMPTS) {
        console.log(
          `[TurbineCables] deferring first bake: coverage ` +
            `${(coverage * 100).toFixed(0)}% < 60% ` +
            `(attempt ${defer.attempts}/${MAX_DEFER_ATTEMPTS})`
        )
        return { enuToEcef, geometries: [] as BufferGeometry[] }
      }
    }
    let floorsPerEdge: number[][]
    if (lock != null && coverage <= lock.bestCoverage + 0.1) {
      floorsPerEdge = lock.floors
    } else {
      // Process the raw samples into usable per-node floors:
      //  - misses filled from the nearest hits (NEVER mixed with the flat
      //    fallback — a hit/miss alternation clamps the rope into a sawtooth);
      //  - boxcar smoothing (±2 nodes) so the rope follows the large-scale
      //    undulation, not the per-triangle photogrammetry noise;
      //  - all-miss cables drop to the flat fallback plane;
      //  - quantized to 0.25 m for a stable bake signature.
      floorsPerEdge = rawPerEdge.map(raw => {
        const n = raw.length
        const filled = new Array<number>(n)
        let last: number | null = null
        let any = false
        for (let i = 0; i < n; i++) {
          if (raw[i] != null) {
            last = raw[i] as number
            any = true
          }
          filled[i] = last ?? NaN
        }
        if (!any) return new Array<number>(n).fill(fallbackY)
        last = null
        for (let i = n - 1; i >= 0; i--) {
          if (raw[i] != null) last = raw[i] as number
          else if (Number.isNaN(filled[i])) filled[i] = last as number
        }
        // UPPER ENVELOPE (windowed max), not an average: averaging rides the
        // middle of the photogrammetry noise, leaving the cable under every
        // local high — "below the seabed" wherever the visible LOD sits
        // above the mean. Riding the envelope means the worst case is a
        // cable slightly proud over a dip, which reads fine.
        const smoothed = new Array<number>(n)
        for (let i = 0; i < n; i++) {
          let hi = -Infinity
          for (let w = -2; w <= 2; w++) {
            const k = i + w
            if (k >= 0 && k < n && filled[k] > hi) hi = filled[k]
          }
          smoothed[i] = Math.round(hi * 4) / 4
        }
        return smoothed
      })
      lockRef.current = {
        topoSig: inputSig,
        bestCoverage: Math.max(coverage, lock?.bestCoverage ?? 0),
        floors: floorsPerEdge,
      }
    }

    // ── Bake (geometry-cached) ────────────────────────────────────────────
    const cables = edges.map(([i, j], e) => {
      const a = localPoints[i].clone()
      const b = localPoints[j].clone()
      const floors = floorsPerEdge[e]
      // An endpoint BELOW its floor (turbine base anchored under the sampled
      // surface) gets lifted onto it — the cable meets the monopile at floor
      // level. Pinning under the clamp floor instead squeezes the rope
      // between clamp and length constraint → sawtooth buckling.
      if (a.y < floors[0]) a.y = floors[0]
      if (b.y < floors[N]) b.y = floors[N]
      return { a, b, floors }
    })

    const sig = JSON.stringify([
      cables.map(c => [c.a.toArray(), c.b.toArray(), c.floors]),
      target.toArray(),
      slack,
      radius,
      segments,
    ])
    if (cacheRef.current?.sig === sig) {
      return cacheRef.current.value
    }

    console.log(
      `[TurbineCables] bake: ${cables.length} cables, coverage ` +
        `${(coverage * 100).toFixed(0)}% (best ` +
        `${((lockRef.current?.bestCoverage ?? 0) * 100).toFixed(0)}%)`
    )

    forcedRef.current = false
    if (baked != null && baked.sig !== inputSig) {
      console.log(
        '[TurbineCables] snapshot sig mismatch — live bake (layout/wind, ' +
          'target, or cable params changed since the snapshot was captured)'
      )
    }
    const nodesPerCable = cables.map(({ a, b, floors }, e) => {
      const nodes = bakeCable(a, b, floors, slack, segments)
      // Bound validation — if this ever fires, a clamp has a hole again.
      // Mirror of bakeCable's per-node ceiling: floor or chord line + margin.
      let worst = 0
      for (let i = 0; i < nodes.length; i++) {
        const chordY = a.y + (b.y - a.y) * (i / (nodes.length - 1))
        const over = nodes[i].y - (Math.max(floors[i], chordY) + 2.5)
        if (over > worst) worst = over
      }
      if (worst > 0) {
        console.warn(
          `[TurbineCables] cable ${e} free-floats ${worst.toFixed(1)} m ` +
            `above its floor/chord ceiling (endpoints ${a.y.toFixed(1)}/` +
            `${b.y.toFixed(1)})`
        )
      }
      return nodes
    })
    const geometries = nodesPerCable.map(nodes => {
      // Smooth tube through the frozen node path, kept in the LOCAL frame —
      // the group matrix below carries the ECEF offset (vertex-level f32
      // can't, see header).
      const curve = new CatmullRomCurve3(nodes)
      return new TubeGeometry(curve, segments * 2, radius, 6, false)
    })

    // Emit a snapshot of this live bake so the story's copy-bake button can
    // persist it (cable-bake.json) — centimetre precision is plenty.
    onBake?.({
      sig: inputSig,
      target: [target.x, target.y, target.z],
      cables: nodesPerCable.map(nodes =>
        nodes.map(
          p =>
            [
              Math.round(p.x * 100) / 100,
              Math.round(p.y * 100) / 100,
              Math.round(p.z * 100) / 100,
            ] as [number, number, number]
        )
      ),
    })

    const value = { enuToEcef, geometries }
    cacheRef.current = { sig, value }
    return value
    // terrainVersion re-samples after tile loads — gated by the coverage lock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bases,
    connectionPoint,
    target,
    seabedDepth,
    terrain,
    terrainVersion,
    maxFloorY,
    slack,
    radius,
    segments,
    baked,
    rebakeNonce,
    onBake,
  ])

  // Dispose replaced geometries (cleanup receives the PREVIOUS array after a
  // re-bake commits, or the final one on unmount).
  useEffect(() => {
    return () => {
      for (const g of geometries) g.dispose()
    }
  }, [geometries])

  if (geometries.length === 0) return null

  return (
    <group matrixAutoUpdate={false} matrix={enuToEcef}>
      {geometries.map((geometry, i) => (
        <mesh key={i} geometry={geometry} material={material} />
      ))}
    </group>
  )
}
