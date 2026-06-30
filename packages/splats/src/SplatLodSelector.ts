// Per-frame, per-LEAF LOD/cull/budget selection over SplatOctreeData, ported from
// PlayCanvas's unified gsplat node-LOD evaluation + budget balancer (MIT). For each
// leaf: frustum-cull, pick a LOD from camera distance via geometric bands, then
// coarsen the farthest leaves to fit a global splat budget. Emits a per-leaf TARGET
// LOD the GPU alpha-ramp expands into per-splat targets. Three-free; O(leaves), so
// it runs synchronously on the main thread (the per-splat gather/sort is on the GPU).

import type { SplatOctreeData } from './SplatOctree'

export interface SplatLodParams {
  /** Max splats rendered per frame. The budget the LOD balancer targets. */
  budget: number
  /** Distance at which a leaf drops from LOD 0 to LOD 1. */
  lodBaseDistance: number
  /** Geometric distance multiplier between consecutive LOD bands. */
  lodMultiplier: number
}

export interface SplatLeafLodResult {
  /**
   * Per-leaf target LOD (integer), parallel to {@link SplatOctreeData.leaves}.
   * `lodLevels` (one past the last real LOD) is the sentinel for a frustum-culled
   * leaf: the GPU treats it as keeping zero splats, so its splats fade out.
   */
  leafTargetLod: Uint32Array
  /** Selected splat count at the chosen LODs (≤ budget after balancing). */
  selectedCount: number
  /** Leaves that passed the frustum cull this frame (diagnostics). */
  visibleLeaves: number
  /** Total octree leaves (diagnostics; `visibleLeaves < totalLeaves` ⇒ culling). */
  totalLeaves: number
}

/**
 * Chooses, each frame, a target LOD per octree leaf: a continuous LOD from camera
 * distance (geometric bands), frustum-culled, then coarsened farthest-first to fit
 * a global splat budget. The per-leaf result is uploaded to the GPU, where the
 * alpha-ramp pass turns it into per-splat target alphas (and the temporal ramp
 * smooths every transition). The frustum is six inward-facing planes packed
 * `[nx, ny, nz, constant] × 6` (as Three's `Frustum.planes` yields); the camera is
 * splat-local. Keeps no per-splat state — that lives on the GPU.
 */
export class SplatLodSelector {
  private readonly octree: SplatOctreeData

  // Per-leaf scratch, sized to the leaf count.
  private readonly leafTargetLod: Uint32Array
  private readonly leafLod: Int32Array
  private readonly leafDistance: Float32Array
  private readonly leafOrder: Uint32Array

  constructor(octree: SplatOctreeData) {
    this.octree = octree
    const leafCount = octree.leaves.length
    this.leafTargetLod = new Uint32Array(leafCount)
    this.leafLod = new Int32Array(leafCount)
    this.leafDistance = new Float32Array(leafCount)
    this.leafOrder = new Uint32Array(leafCount)
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
  ): SplatLeafLodResult {
    const { leaves } = this.octree
    const maxLod = this.octree.lodLevels - 1
    const culledSentinel = this.octree.lodLevels
    const { budget, lodBaseDistance, lodMultiplier } = params
    const invLogMultiplier = 1 / Math.log(lodMultiplier)

    // Culled leaves default to the sentinel (zero splats kept → fade out on GPU).
    this.leafTargetLod.fill(culledSentinel)

    // Pass 1: frustum cull + distance → integer LOD per visible leaf.
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
      let lod: number
      if (maxLod === 0 || distance < lodBaseDistance) {
        lod = 0
      } else {
        lod = Math.min(
          maxLod,
          Math.floor(1 + Math.log(distance / lodBaseDistance) * invLogMultiplier)
        )
      }
      this.leafLod[i] = lod
      this.leafDistance[i] = distance
      this.leafOrder[visibleCount] = i
      visibleCount++
      selectedSplats += leaves[i].lodCounts[lod]
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

    // Write the final per-leaf target LOD for the visible leaves.
    for (let v = 0; v < visibleCount; v++) {
      const i = this.leafOrder[v]
      this.leafTargetLod[i] = this.leafLod[i]
    }

    return {
      leafTargetLod: this.leafTargetLod,
      selectedCount: selectedSplats,
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
}
