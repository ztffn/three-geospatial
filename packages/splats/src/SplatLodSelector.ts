// Per-frame LOD/cull/budget selection over SplatOctreeData, ported from PlayCanvas's
// unified gsplat pipeline (gsplat-octree-instance.evaluateNodeLods + budget-balancer
// + frustum-culler, MIT). For each leaf: frustum-cull, pick a LOD from camera
// distance via geometric bands, then coarsen farthest leaves to fit a global splat
// budget. Gathers survivors, sorts back-to-front, and emits a per-splat LOD-transition
// fade so margin splats dissolve smoothly. Three-free, so it runs in a worker too.

import type { SplatOctreeData } from './SplatOctree'

export interface SplatLodParams {
  /** Max splats rendered per frame. The budget the LOD balancer targets. */
  budget: number
  /** Distance at which a leaf drops from LOD 0 to LOD 1. */
  lodBaseDistance: number
  /** Geometric distance multiplier between consecutive LOD bands. */
  lodMultiplier: number
}

export interface SplatLodResult {
  /** Active splat indices, ordered back-to-front. Valid for `[0, count)`. */
  indices: Uint32Array
  /** Per-instance LOD-transition fade in `[0, 1]`, parallel to {@link indices}. */
  fade: Float32Array
  count: number
  /** Leaves that passed the frustum cull this frame (diagnostics). */
  visibleLeaves: number
  /** Total octree leaves (diagnostics; `visibleLeaves < totalLeaves` ⇒ culling). */
  totalLeaves: number
}

function saturate(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * Selects, each frame, which splats of a {@link SplatOctreeData} to render: a
 * continuous LOD per leaf from camera distance, capped by a global budget,
 * frustum-culled, the survivors sorted farthest-to-nearest, and each tagged with a
 * fade so splats crossing a LOD boundary dissolve instead of popping. The frustum
 * is six inward-facing planes packed `[nx, ny, nz, constant] × 6` (as Three's
 * `Frustum.planes` yields); the camera is splat-local.
 */
export class SplatLodSelector {
  private readonly octree: SplatOctreeData
  private readonly positions: Float32Array

  // Per-leaf scratch, sized to the leaf count.
  private readonly leafLod: Int32Array
  private readonly leafContinuousLod: Float32Array
  private readonly leafDistance: Float32Array
  private readonly leafOrder: Uint32Array

  // Active-set + counting-sort scratch, sized to the full splat count.
  private readonly active: Uint32Array
  private readonly activeFade: Float32Array
  private readonly distances: Float32Array
  private readonly counts: Uint32Array
  private readonly starts: Uint32Array
  private readonly sorted: Uint32Array
  private readonly sortedFade: Float32Array
  private static readonly BUCKET_COUNT = 256 * 256

  constructor(octree: SplatOctreeData, positions: Float32Array) {
    this.octree = octree
    this.positions = positions
    const leafCount = octree.leaves.length
    this.leafLod = new Int32Array(leafCount)
    this.leafContinuousLod = new Float32Array(leafCount)
    this.leafDistance = new Float32Array(leafCount)
    this.leafOrder = new Uint32Array(leafCount)

    const total = octree.totalCount
    this.active = new Uint32Array(total)
    this.activeFade = new Float32Array(total)
    this.distances = new Float32Array(total)
    this.sorted = new Uint32Array(total)
    this.sortedFade = new Float32Array(total)
    this.counts = new Uint32Array(SplatLodSelector.BUCKET_COUNT)
    this.starts = new Uint32Array(SplatLodSelector.BUCKET_COUNT)
  }

  /**
   * @param cameraX Camera X in splat-local space.
   * @param cameraY Camera Y in splat-local space.
   * @param cameraZ Camera Z in splat-local space.
   * @param planes Six inward-facing frustum planes (`[nx,ny,nz,constant]×6`), or
   *   null to skip frustum culling.
   * @param params LOD/budget parameters.
   */
  select(
    cameraX: number,
    cameraY: number,
    cameraZ: number,
    planes: Float32Array | null,
    params: SplatLodParams
  ): SplatLodResult {
    const { leaves } = this.octree
    const maxLod = this.octree.lodLevels - 1
    const { budget, lodBaseDistance, lodMultiplier } = params
    const invLogMultiplier = 1 / Math.log(lodMultiplier)

    // Pass 1: frustum cull + distance → continuous LOD per leaf.
    let visibleCount = 0
    let selectedSplats = 0
    for (let i = 0; i < leaves.length; i++) {
      const bounds = leaves[i].bounds
      if (planes != null && !SplatLodSelector.aabbInFrustum(bounds, planes)) {
        continue
      }
      const distance = SplatLodSelector.distanceToAabb(
        bounds,
        cameraX,
        cameraY,
        cameraZ
      )
      let continuousLod: number
      if (maxLod === 0 || distance < lodBaseDistance) {
        continuousLod = 0
      } else {
        continuousLod = Math.min(
          maxLod,
          1 + Math.log(distance / lodBaseDistance) * invLogMultiplier
        )
      }
      this.leafContinuousLod[i] = continuousLod
      this.leafLod[i] = Math.floor(continuousLod)
      this.leafDistance[i] = distance
      this.leafOrder[visibleCount] = i
      visibleCount++
      selectedSplats += leaves[i].lodCounts[this.leafLod[i]]
    }

    // Pass 2: budget. Coarsen farthest-first until under budget.
    if (selectedSplats > budget) {
      const distance = this.leafDistance
      const farFirst = Array.from(this.leafOrder.subarray(0, visibleCount)).sort(
        (a, b) => distance[b] - distance[a]
      )
      let pass = 0
      while (selectedSplats > budget && pass <= maxLod) {
        let modified = false
        for (let k = 0; k < farFirst.length && selectedSplats > budget; k++) {
          const i = farFirst[k]
          const lod = this.leafLod[i]
          if (lod < maxLod) {
            selectedSplats -=
              leaves[i].lodCounts[lod] - leaves[i].lodCounts[lod + 1]
            this.leafLod[i] = lod + 1
            modified = true
          }
        }
        if (!modified) {
          break
        }
        pass++
      }
    }

    // Gather surviving indices + LOD-transition fade. "Core" splats (present at the
    // next coarser LOD) are opaque; "margin" splats (in this LOD but not the next)
    // fade out as the leaf nears the next band, so the switch is invisible.
    let activeCount = 0
    const src = this.octree.sortedIndices
    const active = this.active
    const activeFade = this.activeFade
    for (let v = 0; v < visibleCount; v++) {
      const i = this.leafOrder[v]
      const leaf = leaves[i]
      const lod = this.leafLod[i]
      const lodCount = leaf.lodCounts[lod]
      const coreCount = lod < maxLod ? leaf.lodCounts[lod + 1] : lodCount
      const marginFade = 1 - saturate(this.leafContinuousLod[i] - lod)
      const base = leaf.offset
      for (let k = 0; k < lodCount; k++) {
        active[activeCount] = src[base + k]
        activeFade[activeCount] = k < coreCount ? 1 : marginFade
        activeCount++
      }
    }

    const sorted = this.sortBackToFront(
      active,
      activeFade,
      activeCount,
      cameraX,
      cameraY,
      cameraZ
    )
    return {
      indices: sorted.indices,
      fade: sorted.fade,
      count: sorted.count,
      visibleLeaves: visibleCount,
      totalLeaves: leaves.length
    }
  }

  // AABB vs six inward-facing planes: outside if the AABB's positive vertex (the
  // corner farthest along a plane's normal) is behind that plane.
  private static aabbInFrustum(bounds: Float32Array, planes: Float32Array): boolean {
    for (let p = 0; p < 6; p++) {
      const nx = planes[p * 4]
      const ny = planes[p * 4 + 1]
      const nz = planes[p * 4 + 2]
      const d = planes[p * 4 + 3]
      const px = nx > 0 ? bounds[3] : bounds[0]
      const py = ny > 0 ? bounds[4] : bounds[1]
      const pz = nz > 0 ? bounds[5] : bounds[2]
      if (nx * px + ny * py + nz * pz + d < 0) {
        return false
      }
    }
    return true
  }

  // Distance from the camera to the closest point on an AABB.
  private static distanceToAabb(
    bounds: Float32Array,
    cx: number,
    cy: number,
    cz: number
  ): number {
    const dx = Math.max(bounds[0] - cx, 0, cx - bounds[3])
    const dy = Math.max(bounds[1] - cy, 0, cy - bounds[4])
    const dz = Math.max(bounds[2] - cz, 0, cz - bounds[5])
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  // Counting sort of the active set by squared distance, farthest-first, carrying
  // the per-splat fade alongside each index.
  private sortBackToFront(
    active: Uint32Array,
    activeFade: Float32Array,
    count: number,
    cx: number,
    cy: number,
    cz: number
  ): { indices: Uint32Array; fade: Float32Array; count: number } {
    const positions = this.positions
    const distances = this.distances

    let minD = Infinity
    let maxD = -Infinity
    for (let k = 0; k < count; k++) {
      const i = active[k]
      const dx = positions[i * 3] - cx
      const dy = positions[i * 3 + 1] - cy
      const dz = positions[i * 3 + 2] - cz
      const d = dx * dx + dy * dy + dz * dz
      distances[k] = d
      if (d < minD) minD = d
      if (d > maxD) maxD = d
    }

    const nb = SplatLodSelector.BUCKET_COUNT
    const counts = this.counts.fill(0)
    const range = maxD - minD
    const scale = range > 0 ? (nb - 1) / range : 0
    for (let k = 0; k < count; k++) {
      counts[((distances[k] - minD) * scale) | 0]++
    }
    // Farthest first: prefix-sum buckets high → low.
    const starts = this.starts
    let total = 0
    for (let b = nb - 1; b >= 0; b--) {
      starts[b] = total
      total += counts[b]
    }
    const sorted = this.sorted
    const sortedFade = this.sortedFade
    for (let k = 0; k < count; k++) {
      const bucket = ((distances[k] - minD) * scale) | 0
      const pos = starts[bucket]++
      sorted[pos] = active[k]
      sortedFade[pos] = activeFade[k]
    }

    return { indices: sorted, fade: sortedFade, count }
  }
}
