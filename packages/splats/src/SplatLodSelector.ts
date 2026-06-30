// Per-frame LOD/cull/budget selection over a SplatOctree, ported from PlayCanvas's
// unified gsplat pipeline (gsplat-octree-instance.evaluateNodeLods + budget-balancer
// + frustum-culler, MIT). For each leaf: frustum-cull, pick a LOD from FOV-adjusted
// camera distance via geometric bands, then coarsen farthest leaves to fit a global
// splat budget. Gathers the surviving indices and sorts them back-to-front to draw.

import { Box3, Vector3, type Frustum } from 'three'

import type { SplatOctree, SplatOctreeLeaf } from './SplatOctree'

export interface SplatLodParams {
  /** Max splats rendered per frame. The budget the LOD balancer targets. */
  budget: number
  /** FOV-adjusted distance at which a leaf drops from LOD 0 to LOD 1. */
  lodBaseDistance: number
  /** Geometric distance multiplier between consecutive LOD bands. */
  lodMultiplier: number
}

export interface SplatLodResult {
  /** Active splat indices, ordered back-to-front. Valid for `[0, count)`. */
  indices: Uint32Array
  count: number
}

const scratchBox = /*#__PURE__*/ new Box3()
const scratchMin = /*#__PURE__*/ new Vector3()
const scratchMax = /*#__PURE__*/ new Vector3()

/**
 * Selects, each frame, which splats of a {@link SplatOctree} to render: LOD per
 * leaf from camera distance, capped by a global budget, frustum-culled, then the
 * surviving indices sorted farthest-to-nearest for correct alpha compositing. The
 * mesh uploads the result as the draw order and sets `instanceCount` to `count`.
 */
export class SplatLodSelector {
  private readonly octree: SplatOctree
  private readonly positions: Float32Array

  // Per-leaf scratch, sized to the leaf count: chosen LOD and distance this frame.
  private readonly leafLod: Int32Array
  private readonly leafDistance: Float32Array
  private readonly leafVisible: Uint8Array
  private readonly leafOrder: Uint32Array

  // Active-set + counting-sort scratch, sized to the full splat count.
  private readonly active: Uint32Array
  private readonly distances: Float32Array
  private readonly counts: Uint32Array
  private readonly starts: Uint32Array
  private readonly sorted: Uint32Array
  private static readonly BUCKET_COUNT = 256 * 256

  constructor(octree: SplatOctree, positions: Float32Array) {
    this.octree = octree
    this.positions = positions
    const leafCount = octree.leaves.length
    this.leafLod = new Int32Array(leafCount)
    this.leafDistance = new Float32Array(leafCount)
    this.leafVisible = new Uint8Array(leafCount)
    this.leafOrder = new Uint32Array(leafCount)

    const total = octree.totalCount
    this.active = new Uint32Array(total)
    this.distances = new Float32Array(total)
    this.sorted = new Uint32Array(total)
    this.counts = new Uint32Array(SplatLodSelector.BUCKET_COUNT)
    this.starts = new Uint32Array(SplatLodSelector.BUCKET_COUNT)
  }

  /**
   * @param cameraLocal Camera position in splat-local space.
   * @param frustum Frustum in splat-local space (clip = projection·modelView), or
   *   null to skip frustum culling.
   * @param params LOD/budget parameters.
   */
  select(
    cameraLocal: Vector3,
    frustum: Frustum | null,
    params: SplatLodParams
  ): SplatLodResult {
    const { leaves } = this.octree
    const maxLod = this.octree.lodLevels - 1
    const { budget, lodBaseDistance, lodMultiplier } = params
    const invLogMultiplier = 1 / Math.log(lodMultiplier)

    // Pass 1: frustum cull + distance → optimal LOD per leaf.
    let visibleCount = 0
    let selectedSplats = 0
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i]
      if (frustum != null && !SplatLodSelector.leafInFrustum(leaf, frustum)) {
        this.leafVisible[i] = 0
        continue
      }
      const distance = SplatLodSelector.distanceToLeaf(leaf, cameraLocal)
      let lod: number
      if (maxLod === 0 || distance < lodBaseDistance) {
        lod = 0
      } else {
        lod = Math.min(
          maxLod,
          Math.floor(Math.log(distance / lodBaseDistance) * invLogMultiplier) + 1
        )
      }
      this.leafVisible[i] = 1
      this.leafLod[i] = lod
      this.leafDistance[i] = distance
      this.leafOrder[visibleCount] = i
      visibleCount++
      selectedSplats += leaf.lodCounts[lod]
    }

    // Pass 2: budget. Coarsen farthest-first until under budget (PlayCanvas degrades
    // the farthest geometry first to preserve nearby quality).
    if (selectedSplats > budget) {
      const order = this.leafOrder.subarray(0, visibleCount)
      // Sort visible leaves farthest → nearest.
      const distance = this.leafDistance
      const farFirst = Array.from(order).sort(
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

    // Gather surviving indices into the active set.
    let activeCount = 0
    const src = this.octree.sortedIndices
    const active = this.active
    for (let v = 0; v < visibleCount; v++) {
      const i = this.leafOrder[v]
      const leaf = leaves[i]
      const lodCount = leaf.lodCounts[this.leafLod[i]]
      const base = leaf.offset
      for (let k = 0; k < lodCount; k++) {
        active[activeCount++] = src[base + k]
      }
    }

    return this.sortBackToFront(active, activeCount, cameraLocal)
  }

  // True if the leaf's AABB intersects the (local-space) frustum.
  private static leafInFrustum(leaf: SplatOctreeLeaf, frustum: Frustum): boolean {
    const b = leaf.bounds
    scratchMin.set(b[0], b[1], b[2])
    scratchMax.set(b[3], b[4], b[5])
    scratchBox.set(scratchMin, scratchMax)
    return frustum.intersectsBox(scratchBox)
  }

  // Distance from the camera to the closest point on the leaf's AABB.
  private static distanceToLeaf(leaf: SplatOctreeLeaf, camera: Vector3): number {
    const b = leaf.bounds
    const dx = Math.max(b[0] - camera.x, 0, camera.x - b[3])
    const dy = Math.max(b[1] - camera.y, 0, camera.y - b[4])
    const dz = Math.max(b[2] - camera.z, 0, camera.z - b[5])
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  // Counting sort of the active set by squared distance, farthest-first (the same
  // bucketed back-to-front order the CPU/GPU full-cloud sorters produce).
  private sortBackToFront(
    active: Uint32Array,
    count: number,
    camera: Vector3
  ): SplatLodResult {
    const positions = this.positions
    const distances = this.distances
    const cx = camera.x
    const cy = camera.y
    const cz = camera.z

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
    for (let k = 0; k < count; k++) {
      const bucket = ((distances[k] - minD) * scale) | 0
      sorted[starts[bucket]++] = active[k]
    }

    return { indices: sorted, count }
  }
}
