// TurbineCables — auto-routed subsea inter-array cables for the offshore farm.
// Self-contained R3F drop-in: given turbine base positions + a connection point
// (ship/substation), it auto-builds a minimum-spanning-tree topology, BAKES each
// cable once with a Verlet rope draped onto a flat seabed floor (no real-time
// physics), and renders the frozen result as static TubeGeometry in ECEF space.
import { useMemo, type FC } from 'react'
import {
  CatmullRomCurve3,
  Matrix4,
  TubeGeometry,
  Vector3,
  type BufferGeometry
} from 'three'
import { MeshLambertNodeMaterial } from 'three/webgpu'

import { Ellipsoid } from '@takram/three-geospatial'

export interface TurbineCablesProps {
  // Turbine base positions in ECEF (world space) — typically the `placements`
  // positions from TurbineFarm. Empty array renders nothing.
  bases: Vector3[]
  // The hub every string runs toward in ECEF: ship deck attach, or substation.
  connectionPoint: Vector3
  // ENU origin for the local sim frame (the farm fly-to target, ECEF). Gravity
  // is -up in this frame; baked nodes are mapped back to ECEF for rendering.
  target: Vector3
  // Seabed depth below sea level, metres. The cable descends to this floor and
  // lies along it. Swap the flat clamp for a terrain raycast once bathymetry
  // geometry exists.
  seabedDepth?: number
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
// constrained to a rest length long enough to reach the seabed and back, and are
// clamped to the floor at y = -depth. The relaxation is deterministic (fixed dt,
// fixed iteration counts) so the same layout always bakes the same geometry.
function bakeCable(
  a: Vector3,
  b: Vector3,
  depth: number,
  slack: number,
  segments: number
): Vector3[] {
  const N = Math.max(2, segments)
  const horiz = Math.hypot(b.x - a.x, b.z - a.z)
  // Total length = horizontal span + the two ~vertical descents + slack. This is
  // what lets the midspan settle ONTO the floor (a pure low-slack catenary would
  // hang short of the seabed on long spans).
  const totalLen = horiz + 2 * depth + horiz * slack
  const rest = totalLen / N

  const pos: Vector3[] = []
  const prev: Vector3[] = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const p = new Vector3().lerpVectors(a, b, t)
    pos.push(p)
    prev.push(p.clone())
  }

  const dt = 1 / 60
  const g = -9.81 * dt * dt // gravity contribution per Verlet step
  const STEPS = 240
  const ITER = 20
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
        const diff = (d - rest) / d
        // Endpoints (index 0 and N) are pinned; interior nodes share correction.
        const w0 = i === 0 ? 0 : 0.5
        const w1 = i + 1 === N ? 0 : 0.5
        p0.set(p0.x + dx * diff * w0, p0.y + dy * diff * w0, p0.z + dz * diff * w0)
        p1.set(p1.x - dx * diff * w1, p1.y - dy * diff * w1, p1.z - dz * diff * w1)
      }
      for (let i = 1; i < N; i++) {
        if (pos[i].y < -depth) pos[i].y = -depth
      }
    }
  }
  return pos
}

export const TurbineCables: FC<TurbineCablesProps> = ({
  bases,
  connectionPoint,
  target,
  seabedDepth = 35,
  slack = 0.05,
  radius = 1.2,
  segments = 28,
  color = 0x1a1d22
}) => {
  const material = useMemo(
    () => new MeshLambertNodeMaterial({ color }),
    [color]
  )

  const geometries = useMemo<BufferGeometry[]>(() => {
    if (bases.length === 0) return []

    // Local ENU basis at the farm target. Columns: x=east, y=up, z=north — so
    // gravity is simply -y and the seabed is the plane y = -seabedDepth.
    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    Ellipsoid.WGS84.getEastNorthUpVectors(target, east, north, up)
    const enuToEcef = new Matrix4().makeBasis(east, up, north).setPosition(target)
    const ecefToEnu = enuToEcef.clone().invert()

    // Endpoints in local frame: hub first, then every base.
    const ecefPoints = [connectionPoint, ...bases]
    const localPoints = ecefPoints.map(p => p.clone().applyMatrix4(ecefToEnu))
    const edges = minimumSpanningTree(ecefPoints)

    return edges.map(([i, j]) => {
      const nodes = bakeCable(
        localPoints[i],
        localPoints[j],
        seabedDepth,
        slack,
        segments
      )
      // Local → ECEF, then a smooth tube through the frozen node path.
      const ecef = nodes.map(p => p.clone().applyMatrix4(enuToEcef))
      const curve = new CatmullRomCurve3(ecef)
      return new TubeGeometry(curve, segments * 2, radius, 6, false)
    })
  }, [bases, connectionPoint, target, seabedDepth, slack, radius, segments])

  if (geometries.length === 0) return null

  return (
    <group>
      {geometries.map((geometry, i) => (
        <mesh key={i} geometry={geometry} material={material} />
      ))}
    </group>
  )
}
